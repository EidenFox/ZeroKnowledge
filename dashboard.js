import { supabase, verificarSessao } from './supabase_client.js';

// Limites de Segurança em RAM
const BLocoDeOfuscacao = 1024 * 1024;
const LIMITE_PREVIEW_DIRETO = 5 * 1024 * 1024; // 5 MB
const LIMITE_PREVIEW_FORCADO = 20 * 1024 * 1024; // 20 MB

function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary_string = window.atob(base64);
    const bytes = new Uint8Array(binary_string.length);
    for (let i = 0; i < binary_string.length; i++) bytes[i] = binary_string.charCodeAt(i);
    return bytes.buffer;
}

const btnUpload = document.getElementById('btnUpload');
const fileInput = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const fileGrid = document.getElementById('fileGrid');
const viewModeSelect = document.getElementById('viewModeSelect');

// Elementos - Partilha e Acessos
const shareModal = document.getElementById('shareModal');
const closeShareModalBtn = document.getElementById('closeShareModalBtn');
const shareFileName = document.getElementById('shareFileName');
const shareEmailInput = document.getElementById('shareEmailInput');
const btnConfirmShare = document.getElementById('btnConfirmShare');
const shareStatus = document.getElementById('shareStatus');

const manageAccessModal = document.getElementById('manageAccessModal');
const closeManageAccessModalBtn = document.getElementById('closeManageAccessModalBtn');
const manageFileName = document.getElementById('manageFileName');
const accessList = document.getElementById('accessList');
const manageAccessStatus = document.getElementById('manageAccessStatus');

// Elementos - Preview
const previewModal = document.getElementById('previewModal');
const closePreviewBtn = document.getElementById('closePreviewBtn');
let viewerInstance = null; // Instância do Viewer.js para destruição limpa

let partilhaAtiva = { arquivoId: null, capsulaDonoBase64: null };

// Listeners Básicos
if (viewModeSelect) {
    viewModeSelect.addEventListener('change', (e) => { fileGrid.className = e.target.value; });
}
closeShareModalBtn.addEventListener('click', () => { shareModal.classList.remove('active'); });
closeManageAccessModalBtn.addEventListener('click', () => { manageAccessModal.classList.remove('active'); });

// Fechar Preview e limpar RAM
closePreviewBtn.addEventListener('click', () => {
    previewModal.classList.remove('active');
    if (viewerInstance) { 
        viewerInstance.destroy(); 
        viewerInstance = null; 
    }
    document.getElementById('previewContainer').innerHTML = ''; 
});

// Monitorização de Rede
const SERVIDOR_FISICO_URL = 'http://localhost:3000';
const serverStatusBadge = document.getElementById('serverStatusBadge');
export let servidorFisicoOnline = false;

async function verificarStatusServidor() {
    try {
        const res = await fetch(`${SERVIDOR_FISICO_URL}/api/status`, { method: 'GET' });
        if (res.ok) {
            servidorFisicoOnline = true;
            serverStatusBadge.textContent = '🟢 Servidor Conectado';
            serverStatusBadge.style.background = 'var(--success)';
            btnUpload.disabled = false;
        } else throw new Error();
    } catch (error) {
        servidorFisicoOnline = false;
        serverStatusBadge.textContent = '🔴 Servidor Offline';
        serverStatusBadge.style.background = 'var(--danger)';
        btnUpload.disabled = true;
        uploadStatus.textContent = "Upload bloqueado. Sem conexão física.";
        uploadStatus.style.color = 'var(--danger)';
    }
}

window.addEventListener('cofreDestrancado', () => {
    verificarStatusServidor();
    setInterval(verificarStatusServidor, 30000);
});

// ==========================================
// MOTOR DE MÍDIA E PREVIEW
// ==========================================

/* Gera miniatura ofuscada de até 50kb usando Canvas antes do upload */
async function gerarThumbnailBase64(file) {
    return new Promise((resolve) => {
        if (!file.type.startsWith('image/') && !file.type.startsWith('video/')) { resolve(null); return; }
        
        const url = URL.createObjectURL(file);
        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d');
        const MAX_DIM = 300; // Limite de 300px para o lado maior

        if (file.type.startsWith('image/')) {
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                let w = img.width, h = img.height;
                if (w > h) { if (w > MAX_DIM) { h *= MAX_DIM / w; w = MAX_DIM; } } 
                else { if (h > MAX_DIM) { w *= MAX_DIM / h; h = MAX_DIM; } }
                canvas.width = w; canvas.height = h;
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', 0.5)); // 50% qualidade
            };
            img.onerror = () => resolve(null);
            img.src = url;
        } else if (file.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.muted = true;
            video.onloadeddata = () => { video.currentTime = 1; }; // Captura o 1º segundo
            video.onseeked = () => {
                let w = video.videoWidth, h = video.videoHeight;
                if (w > h) { if (w > MAX_DIM) { h *= MAX_DIM / w; w = MAX_DIM; } } 
                else { if (h > MAX_DIM) { w *= MAX_DIM / h; h = MAX_DIM; } }
                canvas.width = w; canvas.height = h;
                ctx.drawImage(video, 0, 0, w, h);
                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/jpeg', 0.5));
            };
            video.onerror = () => resolve(null);
            video.src = url;
        }
    });
}

/* Efetua fetch do servidor Node.js e junta os blocos desencriptados */
async function baixarEDescriptografarArquivo(fileId, aesKey, mimeTipo) {
    const response = await fetch(`${SERVIDOR_FISICO_URL}/api/download/${fileId}`);
    if (!response.ok) throw new Error("Ficheiro não encontrado no servidor.");
    
    const fullBuffer = await response.arrayBuffer();
    let offset = 0;
    const decryptedChunks = [];
    const dataView = new DataView(fullBuffer);
    
    // Processa o Enquadramento Binário
    while(offset < fullBuffer.byteLength) {
        const payloadLength = dataView.getUint32(offset, true);
        offset += 4;
        const chunkIV = new Uint8Array(fullBuffer, offset, 12);
        offset += 12;
        const encryptedChunk = fullBuffer.slice(offset, offset + payloadLength);
        offset += payloadLength;
        const decrypted = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: chunkIV }, aesKey, encryptedChunk);
        decryptedChunks.push(decrypted);
    }
    return new Blob(decryptedChunks, { type: mimeTipo });
}

/* Controla a lógica de exibição, limites de tamanho e injeção do visualizador */
async function acionarPreview(fileData, aesKey, mimeTipo, nomeReal) {
    const container = document.getElementById('previewContainer');
    const btnForcar = document.getElementById('btnForceLoad');
    // const btnDownload = document.getElementById('btnPreviewDownload');
    
    // 1. Limpeza de Segurança: Se havia um visualizador aberto antes, force a destruição dele.
    if (viewerInstance) { viewerInstance.destroy(); viewerInstance = null; }
    container.innerHTML = '<p style="color: var(--text-main);">Analisando ficheiro...</p>';
    
    document.getElementById('previewTitle').textContent = nomeReal;
    btnForcar.style.display = 'none';
    previewModal.classList.add('active');

    // 2. Vincula a ação de download diretamente (evita clonar o botão no DOM)
    // btnDownload.onclick = async () => {
    //     btnDownload.disabled = true;
    //     btnDownload.textContent = 'A Processar...';
    //     try {
    //         const blob = await baixarEDescriptografarArquivo(fileData.id, aesKey, mimeTipo);
    //         const url = window.URL.createObjectURL(blob);
    //         const a = document.createElement('a');
    //         a.href = url; a.download = nomeReal;
    //         document.body.appendChild(a); a.click();
    //         document.body.removeChild(a); window.URL.revokeObjectURL(url);
    //     } catch(e) { alert("Erro ao baixar ficheiro físico."); }
    //     btnDownload.textContent = 'Baixar Arquivo';
    //     btnDownload.disabled = false;
    // };

    const renderizarMidia = async () => {
        container.innerHTML = '<p style="color: var(--success);">Descriptografando...</p>';
        try {
            const blob = await baixarEDescriptografarArquivo(fileData.id, aesKey, mimeTipo);
            const url = window.URL.createObjectURL(blob);
            container.innerHTML = '';
            
            if (mimeTipo.startsWith('image/')) {
                const img = document.createElement('img');
                img.src = url;
                container.appendChild(img);
                
                // Inicializa o Viewer respeitando as bordas do contentor
                viewerInstance = new Viewer(img, { 
                    inline: true, 
                    button: false, 
                    navbar: false, 
                    title: false,
                    toolbar: true    // Mostra os botões de zoom e rotação do Viewer
                });
            } else if (mimeTipo.startsWith('video/')) {
                const video = document.createElement('video');
                video.src = url; video.controls = true;
                video.style.maxWidth = '100%'; video.style.maxHeight = '100%';
                container.appendChild(video);
            } else if (mimeTipo === 'application/pdf') {
                const canvas = document.createElement('canvas');
                container.appendChild(canvas);
                const pdf = await pdfjsLib.getDocument(url).promise;
                const page = await pdf.getPage(1);
                const viewport = page.getViewport({ scale: window.innerWidth < 768 ? 1.0 : 1.5 });
                canvas.height = viewport.height; canvas.width = viewport.width;
                await page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise;
            } else {
                container.innerHTML = '<p style="color: var(--text-muted);">Pré-visualização indisponível para este formato. Utilize o botão de download.</p>';
            }
        } catch (e) {
            container.innerHTML = `<p style="color: var(--danger);">Falha ao carregar mídia: ${e.message}</p>`;
        }
    };

    if (fileData.tamanho_bytes > LIMITE_PREVIEW_FORCADO) {
        container.innerHTML = `<div style="text-align: center;"><p style="color: var(--danger); font-size: 1.2em;">Ficheiro Muito Grande (${(fileData.tamanho_bytes/1048576).toFixed(1)}MB)</p><p style="color: var(--text-muted);">A pré-visualização no navegador está desativada para manter a estabilidade. Baixe o arquivo para visualizar.</p></div>`;
    } else if (fileData.tamanho_bytes > LIMITE_PREVIEW_DIRETO) {
        container.innerHTML = `<div style="text-align: center;"><p style="color: var(--accent); font-size: 1.2em;">Ficheiro Pesado (${(fileData.tamanho_bytes/1048576).toFixed(1)}MB)</p><p style="color: var(--text-muted);">Descriptografar este arquivo pode causar travamentos temporários no navegador.</p></div>`;
        btnForcar.style.display = 'block';
        btnForcar.onclick = () => { btnForcar.style.display = 'none'; renderizarMidia(); };
    } else {
        renderizarMidia();
    }
}

// ==========================================
// FLUXO PRINCIPAL DO DASHBOARD
// ==========================================

function abrirModalGerenciamento(arquivoId, nomeReal, acessos) {
    manageFileName.textContent = nomeReal;
    accessList.innerHTML = '';
    manageAccessStatus.textContent = '';

    if (acessos.length === 0) {
        accessList.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 10px;">Nenhum compartilhamento ativo.</li>';
    } else {
        acessos.forEach(acesso => {
            const li = document.createElement('li');
            li.style.cssText = "display: flex; justify-content: space-between; align-items: center; background: var(--bg-surface); padding: 8px 12px; border-radius: 4px;";
            const emailSpan = document.createElement('span');
            emailSpan.textContent = acesso.usuarios.email;
            emailSpan.style.color = "var(--text-main)";

            const btnRevogar = document.createElement('button');
            btnRevogar.textContent = 'Revogar';
            btnRevogar.style.cssText = "background: var(--danger); color: #111; border: none; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 0.8em; font-weight: bold;";

            btnRevogar.addEventListener('click', async () => {
                btnRevogar.disabled = true;
                btnRevogar.textContent = 'Removendo...';
                try {
                    const { error } = await supabase.from('acessos_arquivos').delete().match({ arquivo_id: arquivoId, usuario_id: acesso.usuario_id });
                    if (error) throw error;
                    li.remove();
                    if (accessList.children.length === 0) accessList.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 10px;">Nenhum compartilhamento ativo.</li>';
                    carregarArquivos(); 
                } catch (err) {
                    btnRevogar.disabled = false; btnRevogar.textContent = 'Revogar';
                    manageAccessStatus.style.color = 'var(--danger)'; manageAccessStatus.textContent = 'Erro ao revogar acesso.';
                }
            });

            li.appendChild(emailSpan); li.appendChild(btnRevogar); accessList.appendChild(li);
        });
    }
    manageAccessModal.classList.add('active');
}

export async function carregarArquivos() {
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return;

    fileGrid.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">Buscando e a desencriptar ficheiros...</p>';

    try {
        const { data: arquivos, error } = await supabase.from('arquivos')
            .select(`id, dono_id, tamanho_bytes, data_criacao, nome_original_criptografado, thumbnail_criptografado, mime_type_criptografado, acessos_arquivos ( usuario_id, chave_aes_criptografada, usuarios ( email ) )`)
            .order('data_criacao', { ascending: false });

        if (error) throw error;
        if (!arquivos || arquivos.length === 0) { fileGrid.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">O seu cofre está vazio.</p>'; return; }

        fileGrid.innerHTML = '';

        for (const file of arquivos) {
            try {
                if (!file.acessos_arquivos || file.acessos_arquivos.length === 0) continue;
                const minhaCapsulaObj = file.acessos_arquivos.find(a => a.usuario_id === session.user.id);
                if (!minhaCapsulaObj) continue;

                const capsulaBase64 = minhaCapsulaObj.chave_aes_criptografada;
                const aesKeyBuffer = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, window.chavePrivadaUsuario, base64ToBuffer(capsulaBase64));
                const aesKey = await window.crypto.subtle.importKey("raw", aesKeyBuffer, { name: "AES-GCM", length: 256 }, false, ["decrypt", "encrypt"]);

                const nomePacote = JSON.parse(file.nome_original_criptografado);
                const nomeDecodedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBuffer(nomePacote.iv) }, aesKey, base64ToBuffer(nomePacote.dado));
                const nomeReal = new TextDecoder().decode(nomeDecodedBuffer);
                const isDono = (file.dono_id === session.user.id);

                // --- Fallback do Mime Type ---
                let mimeTipoTratado = 'application/octet-stream';
                try { if (file.mime_type_criptografado) { const mimeData = JSON.parse(file.mime_type_criptografado); if (mimeData.tipo) mimeTipoTratado = mimeData.tipo; } } catch(e){}

                // --- Fallback da Miniatura ---
                let thumbHtml = `
                    <div class="card-thumbnail fallback-thumb" style="display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(0,0,0,0.3); border: 1px solid var(--border-glass); border-radius: 8px; color: var(--text-muted); cursor: pointer; height: 150px;">
                        <span style="font-size: 2.5rem;">📄</span>
                        <span style="font-size: 0.75em; margin-top: 8px;">Mídia Indisponível</span>
                    </div>`;
                
                if (file.thumbnail_criptografado) {
                    try {
                        const thumbPacote = JSON.parse(file.thumbnail_criptografado);
                        const thumbDecodedBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBuffer(thumbPacote.iv) }, aesKey, base64ToBuffer(thumbPacote.dado));
                        const thumbBase64Decoded = new TextDecoder().decode(thumbDecodedBuffer);
                        thumbHtml = `<img src="${thumbBase64Decoded}" class="card-thumbnail" title="Clique para pré-visualizar" style="object-fit: cover; width: 100%; height: 150px; border-radius: 8px; cursor: pointer; background: #000;">`;
                    } catch (thumbError) {
                        console.warn("Falha ao descriptografar miniatura do arquivo: " + file.id, thumbError);
                        // Mantém o thumbHtml de Fallback
                    }
                } else if (mimeTipoTratado === 'application/pdf') {
                    // Ícone específico para PDF caso não tenha miniatura
                    thumbHtml = `
                    <div class="card-thumbnail fallback-thumb" style="display: flex; flex-direction: column; justify-content: center; align-items: center; background: rgba(200,0,0,0.1); border: 1px solid var(--border-glass); border-radius: 8px; color: var(--danger); cursor: pointer; height: 150px;">
                        <span style="font-size: 2.5rem;">📕</span>
                        <span style="font-size: 0.75em; margin-top: 8px;">Documento PDF</span>
                    </div>`;
                }

                const card = document.createElement('div');
                card.style.cssText = "background: var(--bg-surface); padding: 15px; border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: space-between;";

                let botoesAcao = '';
                let infoCompartilhamento = '';

                if (isDono) {
                    const convidados = file.acessos_arquivos.filter(a => a.usuario_id !== session.user.id);
                    infoCompartilhamento = `<p style="margin: 5px 0 0 0; font-size: 0.85em; color: var(--accent);">👥 Partilhado com: <b>${convidados.length}</b></p>`;
                    botoesAcao = `
                        <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
                            <button class="btn-baixar" ${!servidorFisicoOnline ? 'disabled' : ''} style="flex: 1; padding: 5px; background: var(--success); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; opacity: ${!servidorFisicoOnline ? '0.5' : '1'};">Baixar</button>
                            <button class="btn-partilhar" style="flex: 1; padding: 5px; background: var(--accent); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Partilhar</button>
                            <button class="btn-gerenciar" style="flex: 1; padding: 5px; background: transparent; color: var(--text-main); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;">Acessos</button>
                            <button class="btn-excluir" style="width: 100%; padding: 5px; background: transparent; color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; cursor: pointer; margin-top: 5px;">Excluir Ficheiro</button>
                        </div>
                    `;
                } else {
                    infoCompartilhamento = `<p style="margin: 5px 0 0 0; font-size: 0.85em; color: var(--success);">🤝 Partilhado consigo</p>`;
                    botoesAcao = `
                        <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
                            <button class="btn-baixar" ${!servidorFisicoOnline ? 'disabled' : ''} style="flex: 1; padding: 5px; background: var(--success); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; opacity: ${!servidorFisicoOnline ? '0.5' : '1'};">Baixar</button>
                            <button class="btn-recusar" style="width: 100%; padding: 5px; background: var(--bg-base); color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; cursor: pointer; margin-top: 5px;">Sair do Arquivo</button>
                        </div>
                    `;
                }

                card.innerHTML = `
                    <div style="display: flex; flex-direction: column; width: 100%;">
                        ${thumbHtml}
                        <div style="flex: 1; margin-top: 10px;">
                            <h4 style="margin: 0 0 5px 0; color: var(--text-main); font-size: 0.9em; word-break: break-all;">${nomeReal}</h4>
                            <p style="margin: 0; font-size: 0.75em; color: var(--text-muted);">${(file.tamanho_bytes / 1048576).toFixed(2)} MB</p>
                            ${infoCompartilhamento}
                        </div>
                    </div>
                    <div>
                        <p style="margin: 10px 0 0 0; font-size: 0.75em; color: var(--text-muted); text-align: right;">${new Date(file.data_criacao).toLocaleDateString()}</p>
                        ${botoesAcao}
                    </div>
                `;

                // Eventos
                card.querySelector('.card-thumbnail').addEventListener('click', () => { acionarPreview(file, aesKey, mimeTipoTratado, nomeReal); });

                if (isDono) {
                    card.querySelector('.btn-partilhar').addEventListener('click', () => {
                        partilhaAtiva = { arquivoId: file.id, capsulaDonoBase64: capsulaBase64 };
                        shareFileName.textContent = nomeReal; shareEmailInput.value = ''; shareStatus.textContent = ''; shareModal.classList.add('active');
                    });
                    card.querySelector('.btn-gerenciar').addEventListener('click', () => {
                        abrirModalGerenciamento(file.id, nomeReal, file.acessos_arquivos.filter(a => a.usuario_id !== session.user.id));
                    });
                    card.querySelector('.btn-excluir').addEventListener('click', async (e) => {
                        if(!confirm("Atenção: Eliminar este ficheiro irá apagá-lo para todos os convidados e destruí-lo do servidor físico. Proceder?")) return;
                        e.target.disabled = true;
                        try {
                            const { error } = await supabase.from('arquivos').delete().eq('id', file.id);
                            if (error) throw error;
                            carregarArquivos();
                        } catch(err) { alert("Erro ao excluir."); e.target.disabled = false; }
                    });
                } else {
                    card.querySelector('.btn-recusar').addEventListener('click', async (e) => {
                        if (!confirm('Deseja remover o seu acesso a este ficheiro?')) return;
                        e.target.disabled = true;
                        try {
                            await supabase.from('acessos_arquivos').delete().match({ arquivo_id: file.id, usuario_id: session.user.id });
                            carregarArquivos();
                        } catch (err) { console.error(err); e.target.disabled = false; }
                    });
                }

                // Evento Baixar Direto (Download normal)
                const btnBaixar = card.querySelector('.btn-baixar');
                if (btnBaixar) {
                    btnBaixar.addEventListener('click', async (e) => {
                        const btn = e.target; btn.disabled = true; btn.textContent = 'A processar...';
                        try {
                            const blob = await baixarEDescriptografarArquivo(file.id, aesKey, mimeTipoTratado);
                            const url = window.URL.createObjectURL(blob);
                            const a = document.createElement('a'); a.style.display = 'none';
                            a.href = url; a.download = nomeReal;
                            document.body.appendChild(a); a.click();
                            window.URL.revokeObjectURL(url); document.body.removeChild(a);
                            btn.textContent = 'Concluído'; setTimeout(() => { btn.textContent = 'Baixar'; btn.disabled = false; }, 2000);
                        } catch (err) {
                            btn.textContent = 'Erro'; btn.style.background = 'var(--danger)';
                            setTimeout(() => { btn.textContent = 'Baixar'; btn.style.background = 'green'; btn.disabled = false; }, 3000);
                        }
                    });
                }

                fileGrid.appendChild(card);
            } catch (decryptionError) { console.error("Ficheiro Ilegível", file.id, decryptionError); }
        }
    } catch (err) { console.error("Erro na grelha:", err); }
}

btnConfirmShare.addEventListener('click', async () => {
    const emailDestino = shareEmailInput.value.trim();
    if (!emailDestino) return;
    btnConfirmShare.disabled = true; shareStatus.style.color = 'var(--text-muted)'; shareStatus.textContent = 'A gerar cápsula matemática de transferência...';
    try {
        const { data: usuarioDestino, error: erroUser } = await supabase.from('usuarios').select('id, chave_publica').eq('email', emailDestino).single();
        if (erroUser || !usuarioDestino) throw new Error("Utilizador não encontrado.");

        const aesKeyRawBuffer = await window.crypto.subtle.decrypt({ name: "RSA-OAEP" }, window.chavePrivadaUsuario, base64ToBuffer(partilhaAtiva.capsulaDonoBase64));
        const pubKeyDestino = await window.crypto.subtle.importKey("spki", base64ToBuffer(usuarioDestino.chave_publica), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
        const novaCapsulaAES = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKeyDestino, aesKeyRawBuffer);

        const { error: erroAcesso } = await supabase.from('acessos_arquivos').insert([{ arquivo_id: partilhaAtiva.arquivoId, usuario_id: usuarioDestino.id, chave_aes_criptografada: bufferToBase64(novaCapsulaAES) }]);
        if (erroAcesso) { if (erroAcesso.code === '23505') throw new Error("Este utilizador já possui acesso."); throw erroAcesso; }

        shareStatus.style.color = 'var(--success)'; shareStatus.textContent = '✅ Ficheiro partilhado com sucesso!';
        await carregarArquivos(); setTimeout(() => { shareModal.classList.remove('active'); }, 2000);
    } catch (err) { shareStatus.style.color = 'var(--danger)'; shareStatus.textContent = "Erro: " + err.message; } 
    finally { btnConfirmShare.disabled = false; }
});

btnUpload.addEventListener('click', async () => {
    if (fileInput.files.length === 0) return alert("Selecione um ficheiro primeiro.");
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return alert("Sessão inválida. Faça login novamente.");

    const file = fileInput.files[0];
    btnUpload.disabled = true;

    try {
        uploadStatus.textContent = "1/5: Preparando criptografia e Thumbnail...";
        const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        
        const pacoteMime = JSON.stringify({ tipo: file.type || 'application/octet-stream' });
        
        let thumbnailEncrypedJson = null;
        const thumbBase64Data = await gerarThumbnailBase64(file);
        if (thumbBase64Data) {
            const ivThumb = window.crypto.getRandomValues(new Uint8Array(12));
            const thumbBuffer = new TextEncoder().encode(thumbBase64Data);
            const thumbEncrypted = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: ivThumb }, aesKey, thumbBuffer);
            thumbnailEncrypedJson = JSON.stringify({ iv: bufferToBase64(ivThumb), dado: bufferToBase64(thumbEncrypted) });
        }

        const ivNome = window.crypto.getRandomValues(new Uint8Array(12));
        const nomeCriptografado = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: ivNome }, aesKey, new TextEncoder().encode(file.name));
        const pacoteNome = JSON.stringify({ iv: bufferToBase64(ivNome), dado: bufferToBase64(nomeCriptografado) });

        const hashBuffer = await window.crypto.subtle.digest('SHA-256', await file.slice(0, 1024).arrayBuffer());
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
        const tamanhoOfuscado = Math.ceil(file.size / BLocoDeOfuscacao) * BLocoDeOfuscacao;

        uploadStatus.textContent = "2/5: Registando cofre na nuvem Supabase...";
        const { data: userData, error: userError } = await supabase.from('usuarios').select('chave_publica').eq('id', session.user.id).single();
        if (userError) throw userError;

        const pubKeyRSA = await window.crypto.subtle.importKey("spki", base64ToBuffer(userData.chave_publica), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
        const aesKeyRaw = await window.crypto.subtle.exportKey("raw", aesKey);
        const capsulaAES = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKeyRSA, aesKeyRaw);

        const { data: arquivoRecord, error: arquivoError } = await supabase.from('arquivos')
            .insert([{ 
                dono_id: session.user.id, 
                nome_original_criptografado: pacoteNome, 
                tamanho_bytes: tamanhoOfuscado, 
                hash_sha256: hashHex, 
                mime_type_criptografado: pacoteMime,
                thumbnail_criptografado: thumbnailEncrypedJson 
            }]).select('id').single();
        if (arquivoError) throw arquivoError;

        await supabase.from('acessos_arquivos').insert([{ arquivo_id: arquivoRecord.id, usuario_id: session.user.id, chave_aes_criptografada: bufferToBase64(capsulaAES) }]);

        const CHUNK_SIZE = 5 * 1024 * 1024;
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            uploadStatus.textContent = `3/5: Enviando blocos físicos (${i + 1}/${totalChunks})...`;
            const chunkBuffer = await file.slice(i * CHUNK_SIZE, (i * CHUNK_SIZE) + CHUNK_SIZE).arrayBuffer();
            const chunkIV = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedChunk = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv: chunkIV }, aesKey, chunkBuffer);

            const lengthBuffer = new ArrayBuffer(4);
            new DataView(lengthBuffer).setUint32(0, encryptedChunk.byteLength, true);
            
            const formData = new FormData();
            formData.append('chunk', new Blob([lengthBuffer, chunkIV, encryptedChunk]));
            const resUpload = await fetch(`${SERVIDOR_FISICO_URL}/api/upload/${arquivoRecord.id}`, { method: 'POST', body: formData });
            if (!resUpload.ok) throw new Error("Falha no servidor físico.");
        }

        uploadStatus.style.color = "var(--success)"; uploadStatus.textContent = "✅ Envio concluído!";
        fileInput.value = ''; await carregarArquivos();
    } catch (err) { uploadStatus.style.color = "var(--danger)"; uploadStatus.textContent = "Erro: " + err.message; }
    finally { btnUpload.disabled = false; setTimeout(() => uploadStatus.textContent = '', 5000); }
});

window.addEventListener('cofreDestrancado', carregarArquivos);