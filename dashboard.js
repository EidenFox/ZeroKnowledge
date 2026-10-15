import { supabase, verificarSessao } from './supabase_client.js';

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

// Elementos - Partilha
const shareModal = document.getElementById('shareModal');
const closeShareModalBtn = document.getElementById('closeShareModalBtn');
const shareFileName = document.getElementById('shareFileName');
const shareEmailInput = document.getElementById('shareEmailInput');
const btnConfirmShare = document.getElementById('btnConfirmShare');
const shareStatus = document.getElementById('shareStatus');

// Elementos - Gestão de Acessos
const manageAccessModal = document.getElementById('manageAccessModal');
const closeManageAccessModalBtn = document.getElementById('closeManageAccessModalBtn');
const manageFileName = document.getElementById('manageFileName');
const accessList = document.getElementById('accessList');
const manageAccessStatus = document.getElementById('manageAccessStatus');

let partilhaAtiva = { arquivoId: null, capsulaDonoBase64: null };

closeShareModalBtn.addEventListener('click', () => { shareModal.classList.remove('active'); });
closeManageAccessModalBtn.addEventListener('click', () => { manageAccessModal.classList.remove('active'); });


const SERVIDOR_FISICO_URL = 'http://localhost:3000';
const serverStatusBadge = document.getElementById('serverStatusBadge');
export let servidorFisicoOnline = false;

/* INICIO DE FUNÇÃO DE monitorizacao_rede; pinga o servidor físico a cada 10 segundos e adapta a UI */
async function verificarStatusServidor() {
    try {
        const res = await fetch(`${SERVIDOR_FISICO_URL}/api/status`, { method: 'GET' });
        if (res.ok) {
            servidorFisicoOnline = true;
            serverStatusBadge.textContent = '🟢 Servidor Conectado';
            serverStatusBadge.style.background = 'var(--success)';
            btnUpload.disabled = false;
        } else {
            throw new Error('Servidor retornou erro.');
        }
    } catch (error) {
        servidorFisicoOnline = false;
        serverStatusBadge.textContent = '🔴 Servidor Offline';
        serverStatusBadge.style.background = 'var(--danger)';
        btnUpload.disabled = true; // Impede novos uploads
        uploadStatus.textContent = "Upload bloqueado. Sem conexão com o servidor físico.";
        uploadStatus.style.color = 'var(--danger)';
    }
}

// Inicia o ciclo de ping quando o cofre é destrancado
window.addEventListener('cofreDestrancado', () => {
    verificarStatusServidor();
    setInterval(verificarStatusServidor, 30000); // Repete a cada 30 segundos
});

/* INICIO DE FUNÇÃO DE modal_gerenciamento; popula a lista de utilizadores que possuem acesso ao ficheiro atual */
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

            // Ação de revogação de acesso (Deleta a cápsula do banco de dados)
            btnRevogar.addEventListener('click', async () => {
                btnRevogar.disabled = true;
                btnRevogar.textContent = 'Removendo...';
                try {
                    const { error } = await supabase.from('acessos_arquivos')
                        .delete()
                        .match({ arquivo_id: arquivoId, usuario_id: acesso.usuario_id });

                    if (error) throw error;

                    li.remove();
                    if (accessList.children.length === 0) {
                        accessList.innerHTML = '<li style="color: var(--text-muted); text-align: center; padding: 10px;">Nenhum compartilhamento ativo.</li>';
                    }
                    carregarArquivos(); // Recarrega a grade em background para atualizar o contador
                } catch (err) {
                    console.error(err);
                    btnRevogar.disabled = false;
                    btnRevogar.textContent = 'Revogar';
                    manageAccessStatus.style.color = 'var(--danger)';
                    manageAccessStatus.textContent = 'Erro ao revogar acesso.';
                }
            });

            li.appendChild(emailSpan);
            li.appendChild(btnRevogar);
            accessList.appendChild(li);
        });
    }

    manageAccessModal.classList.add('active');
}

export async function carregarArquivos() {
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return;

    fileGrid.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">Buscando e a desencriptar ficheiros...</p>';

    try {
        // Query com JOIN relacional: Puxa o e-mail do dono da cápsula da tabela 'usuarios'
        const { data: arquivos, error } = await supabase
            .from('arquivos')
            .select(`
                id, dono_id, tamanho_bytes, data_criacao, nome_original_criptografado,
                acessos_arquivos ( 
                    usuario_id, 
                    chave_aes_criptografada,
                    usuarios ( email )
                )
            `)
            .order('data_criacao', { ascending: false });

        if (error) throw error;
        if (!arquivos || arquivos.length === 0) {
            fileGrid.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">O seu cofre está vazio.</p>';
            return;
        }

        fileGrid.innerHTML = '';

        for (const file of arquivos) {
            try {
                if (!file.acessos_arquivos || file.acessos_arquivos.length === 0) continue;

                // Isole a cápsula referente APENAS ao usuário atual
                const minhaCapsulaObj = file.acessos_arquivos.find(a => a.usuario_id === session.user.id);
                if (!minhaCapsulaObj) continue;

                const capsulaBase64 = minhaCapsulaObj.chave_aes_criptografada;
                const aesKeyBuffer = await window.crypto.subtle.decrypt(
                    { name: "RSA-OAEP" }, window.chavePrivadaUsuario, base64ToBuffer(capsulaBase64)
                );
                const aesKey = await window.crypto.subtle.importKey(
                    "raw", aesKeyBuffer, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
                );

                const nomePacote = JSON.parse(file.nome_original_criptografado);
                const nomeDecodedBuffer = await window.crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: base64ToBuffer(nomePacote.iv) }, aesKey, base64ToBuffer(nomePacote.dado)
                );
                const nomeReal = new TextDecoder().decode(nomeDecodedBuffer);
                const tamanhoMB = (file.tamanho_bytes / (1024 * 1024)).toFixed(2);
                const isDono = (file.dono_id === session.user.id);

                const card = document.createElement('div');
                card.style.cssText = "background: var(--bg-surface); padding: 15px; border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: space-between;";

                let botoesAcao = '';
                let infoCompartilhamento = '';

                if (isDono) {
                    const convidados = file.acessos_arquivos.filter(a => a.usuario_id !== session.user.id);
                    infoCompartilhamento = `<p style="margin: 5px 0 0 0; font-size: 0.85em; color: var(--accent);">👥 Partilhado com: <b>${convidados.length}</b></p>`;
                    botoesAcao = `
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <button class="btn-baixar" ${!servidorFisicoOnline ? 'disabled' : ''} style="flex: 1; padding: 5px; background: var(--success); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; opacity: ${!servidorFisicoOnline ? '0.5' : '1'};">Baixar</button>
                            <button class="btn-partilhar" style="flex: 1; padding: 5px; background: var(--accent); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold;">Partilhar</button>
                            <button class="btn-gerenciar" style="flex: 1; padding: 5px; background: transparent; color: var(--text-main); border: 1px solid var(--border); border-radius: 4px; cursor: pointer;">Acessos</button>
                        </div>
                    `;
                } else {
                    infoCompartilhamento = `<p style="margin: 5px 0 0 0; font-size: 0.85em; color: var(--success);">🤝 Partilhado consigo</p>`;
                    botoesAcao = `
                        <div style="display: flex; gap: 8px; margin-top: 10px;">
                            <button class="btn-baixar" ${!servidorFisicoOnline ? 'disabled' : ''} style="flex: 1; padding: 5px; background: var(--success); color: #111; border: none; border-radius: 4px; cursor: pointer; font-weight: bold; opacity: ${!servidorFisicoOnline ? '0.5' : '1'};">Baixar</button>
                            <button class="btn-recusar" style="width: 100%; padding: 5px; background: var(--bg-base); color: var(--danger); border: 1px solid var(--danger); border-radius: 4px; cursor: pointer;">Sair do Arquivo</button>
                        </div>
                    `;
                }

                card.innerHTML = `
                    <div>
                        <h4 style="margin: 0 0 10px 0; color: var(--accent); word-break: break-all;">📄 ${nomeReal}</h4>
                        <p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">Tamanho: ${tamanhoMB} MB</p>
                        ${infoCompartilhamento}
                    </div>
                    <div>
                        <p style="margin: 10px 0 0 0; font-size: 0.75em; color: var(--text-muted); text-align: right;">${new Date(file.data_criacao).toLocaleDateString()}</p>
                        ${botoesAcao}
                    </div>
                `;

                if (isDono) {
                    card.querySelector('.btn-partilhar').addEventListener('click', () => {
                        partilhaAtiva = { arquivoId: file.id, capsulaDonoBase64: capsulaBase64 };
                        shareFileName.textContent = nomeReal;
                        shareEmailInput.value = '';
                        shareStatus.textContent = '';
                        shareModal.classList.add('active');
                    });

                    card.querySelector('.btn-gerenciar').addEventListener('click', () => {
                        const convidados = file.acessos_arquivos.filter(a => a.usuario_id !== session.user.id);
                        abrirModalGerenciamento(file.id, nomeReal, convidados);
                    });
                } else {
                    card.querySelector('.btn-recusar').addEventListener('click', async (e) => {
                        if (!confirm('Deseja remover o seu acesso a este ficheiro? Não afetará os outros utilizadores.')) return;
                        e.target.disabled = true;
                        try {
                            await supabase.from('acessos_arquivos').delete().match({ arquivo_id: file.id, usuario_id: session.user.id });
                            carregarArquivos(); // Ficheiro desaparece imediatamente
                        } catch (err) { console.error(err); e.target.disabled = false; }
                    });
                }

                fileGrid.appendChild(card);

                // Adiciona o ouvinte de eventos para baixar e desencriptar
                const btnBaixar = card.querySelector('.btn-baixar');
                if (btnBaixar) {
                    btnBaixar.addEventListener('click', async (e) => {
                        const btn = e.target;
                        btn.disabled = true;
                        btn.textContent = 'A processar...';
                        
                        try {
                            // 1. Busca o ficheiro físico encriptado no servidor Node.js
                            const response = await fetch(`${SERVIDOR_FISICO_URL}/api/download/${file.id}`);
                            if (!response.ok) throw new Error("Ficheiro não encontrado no servidor.");
                            
                            const fullBuffer = await response.arrayBuffer();
                            let offset = 0;
                            const decryptedChunks = [];
                            const dataView = new DataView(fullBuffer);
                            
                            // 2. Lê sequencialmente o protocolo de Enquadramento Binário
                            while(offset < fullBuffer.byteLength) {
                                const payloadLength = dataView.getUint32(offset, true);
                                offset += 4;
                                
                                const chunkIV = new Uint8Array(fullBuffer, offset, 12);
                                offset += 12;
                                
                                const encryptedChunk = fullBuffer.slice(offset, offset + payloadLength);
                                offset += payloadLength;
                                
                                const decrypted = await window.crypto.subtle.decrypt(
                                    { name: "AES-GCM", iv: chunkIV }, aesKey, encryptedChunk
                                );
                                decryptedChunks.push(decrypted);
                            }
                            
                            // 3. Resiliência do Mime-Type (Proteção contra o erro "undefined")
                            let mimeTipoTratado = 'application/octet-stream'; // Fallback padrão
                            try {
                                if (file.mime_type_criptografado) {
                                    const mimeData = JSON.parse(file.mime_type_criptografado);
                                    if (mimeData && mimeData.tipo) {
                                        mimeTipoTratado = mimeData.tipo;
                                    }
                                }
                            } catch (mimeError) {
                                console.warn("Aviso: Mime-Type ausente ou mal formatado no banco de dados. Usando o padrão genérico.", mimeError);
                            }
                            
                            // 4. Remonta o ficheiro original e força o download
                            const finalBlob = new Blob(decryptedChunks, { type: mimeTipoTratado });
                            
                            const url = window.URL.createObjectURL(finalBlob);
                            const a = document.createElement('a');
                            a.style.display = 'none';
                            a.href = url;
                            a.download = nomeReal;
                            document.body.appendChild(a);
                            a.click();
                            window.URL.revokeObjectURL(url);
                            document.body.removeChild(a);

                            btn.textContent = 'Concluído';
                            setTimeout(() => { btn.textContent = 'Baixar'; btn.disabled = false; }, 2000);

                        } catch (err) {
                            console.error(err);
                            btn.textContent = 'Erro';
                            btn.style.background = 'var(--danger)';
                            setTimeout(() => { btn.textContent = 'Baixar'; btn.style.background = 'green'; btn.disabled = false; }, 3000);
                        }
                    });
                }

            } catch (decryptionError) {
                console.error("Ficheiro Ilegível", file.id, decryptionError);
            }
        }
    } catch (err) {
        console.error("Erro na grelha:", err);
    }
}

btnConfirmShare.addEventListener('click', async () => {
    const emailDestino = shareEmailInput.value.trim();
    if (!emailDestino) return;

    btnConfirmShare.disabled = true;
    shareStatus.style.color = 'var(--text-muted)';
    shareStatus.textContent = 'A gerar cápsula matemática de transferência...';

    try {
        const { data: usuarioDestino, error: erroUser } = await supabase.from('usuarios').select('id, chave_publica').eq('email', emailDestino).single();
        if (erroUser || !usuarioDestino) throw new Error("Utilizador não encontrado.");

        const aesKeyRawBuffer = await window.crypto.subtle.decrypt(
            { name: "RSA-OAEP" }, window.chavePrivadaUsuario, base64ToBuffer(partilhaAtiva.capsulaDonoBase64)
        );

        const pubKeyDestino = await window.crypto.subtle.importKey(
            "spki", base64ToBuffer(usuarioDestino.chave_publica), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
        );

        const novaCapsulaAES = await window.crypto.subtle.encrypt(
            { name: "RSA-OAEP" }, pubKeyDestino, aesKeyRawBuffer
        );

        const { error: erroAcesso } = await supabase.from('acessos_arquivos')
            .insert([{ arquivo_id: partilhaAtiva.arquivoId, usuario_id: usuarioDestino.id, chave_aes_criptografada: bufferToBase64(novaCapsulaAES) }]);

        if (erroAcesso) {
            if (erroAcesso.code === '23505') throw new Error("Este utilizador já possui acesso.");
            throw erroAcesso;
        }

        shareStatus.style.color = 'var(--success)';
        shareStatus.textContent = '✅ Ficheiro partilhado com sucesso!';

        await carregarArquivos(); // Atualiza a contagem na interface imediatamente
        setTimeout(() => { shareModal.classList.remove('active'); }, 2000);

    } catch (err) {
        shareStatus.style.color = 'var(--danger)';
        shareStatus.textContent = "Erro: " + err.message;
    } finally {
        btnConfirmShare.disabled = false;
    }
});

/* INICIO DE FUNÇÃO DE orquestrar_upload; fatiamento, encriptação e envio físico */
btnUpload.addEventListener('click', async () => {
    if (fileInput.files.length === 0) return alert("Selecione um ficheiro primeiro.");
    
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return alert("Sessão inválida. Faça login novamente.");

    const file = fileInput.files[0];
    btnUpload.disabled = true;

    try {
        uploadStatus.textContent = "Passo 1/4: Gerando chaves AES e metadados...";
        const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
        const ivNome = window.crypto.getRandomValues(new Uint8Array(12));
        const nomeCriptografado = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: ivNome }, aesKey, new TextEncoder().encode(file.name)
        );
        const pacoteNome = JSON.stringify({ iv: bufferToBase64(ivNome), dado: bufferToBase64(nomeCriptografado) });
        const hashBuffer = await window.crypto.subtle.digest('SHA-256', await file.slice(0, 1024).arrayBuffer());
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        const BLocoDeOfuscacao = 1024 * 1024;
        const tamanhoOfuscado = Math.ceil(file.size / BLocoDeOfuscacao) * BLocoDeOfuscacao;

        uploadStatus.textContent = "Passo 2/4: Registando cofre na nuvem Supabase...";
        const { data: userData, error: userError } = await supabase.from('usuarios').select('chave_publica').eq('id', session.user.id).single();
        if (userError) throw userError;

        const pubKeyRSA = await window.crypto.subtle.importKey("spki", base64ToBuffer(userData.chave_publica), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]);
        const aesKeyRaw = await window.crypto.subtle.exportKey("raw", aesKey);
        const capsulaAES = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKeyRSA, aesKeyRaw);

        const { data: arquivoRecord, error: arquivoError } = await supabase.from('arquivos')
            .insert([{ dono_id: session.user.id, nome_original_criptografado: pacoteNome, tamanho_bytes: tamanhoOfuscado, hash_sha256: hashHex, mime_type_criptografado: JSON.stringify({ tipo: file.type }) }])
            .select('id').single();
        if (arquivoError) throw arquivoError;

        const { error: acessoError } = await supabase.from('acessos_arquivos')
            .insert([{ arquivo_id: arquivoRecord.id, usuario_id: session.user.id, chave_aes_criptografada: bufferToBase64(capsulaAES) }]);
        if (acessoError) throw acessoError;

        // --- FASE DE TRÁFEGO FÍSICO ---
        const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB por bloco
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

        for (let i = 0; i < totalChunks; i++) {
            uploadStatus.textContent = `Passo 3/4: Encriptando e enviando bloco ${i + 1} de ${totalChunks}...`;
            const offset = i * CHUNK_SIZE;
            const chunkBuffer = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
            
            const chunkIV = window.crypto.getRandomValues(new Uint8Array(12));
            const encryptedChunk = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: chunkIV }, aesKey, chunkBuffer
            );

            // Enquadramento Binário: 4 bytes indicando o tamanho + 12 bytes IV + Bloco Encriptado
            const lengthBuffer = new ArrayBuffer(4);
            new DataView(lengthBuffer).setUint32(0, encryptedChunk.byteLength, true); // Little endian
            
            const pacoteFisico = new Blob([lengthBuffer, chunkIV, encryptedChunk]);
            const formData = new FormData();
            formData.append('chunk', pacoteFisico);

            const resUpload = await fetch(`${SERVIDOR_FISICO_URL}/api/upload/${arquivoRecord.id}`, {
                method: 'POST',
                body: formData
            });

            if (!resUpload.ok) throw new Error("Falha ao comunicar com o servidor físico.");
        }

        uploadStatus.style.color = "var(--success)";
        uploadStatus.textContent = "✅ Sucesso! Ficheiro encriptado e guardado fisicamente.";
        fileInput.value = '';
        await carregarArquivos(); 

    } catch (err) {
        uploadStatus.style.color = "var(--danger)";
        uploadStatus.textContent = "Erro: " + err.message;
    } finally {
        btnUpload.disabled = false;
        setTimeout(() => uploadStatus.textContent = '', 5000);
    }
});

window.addEventListener('cofreDestrancado', carregarArquivos);