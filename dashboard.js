import { supabase, verificarSessao } from './supabase_client.js';

/* INICIO DE FUNÇÃO DE utilitarios_base64; conversão entre formatos para o banco de dados e APIs criptográficas */
function bufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary_string = window.atob(base64);
    const bytes = new Uint8Array(binary_string.length);
    for (let i = 0; i < binary_string.length; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

const btnUpload = document.getElementById('btnUpload');
const fileInput = document.getElementById('fileInput');
const uploadStatus = document.getElementById('uploadStatus');
const fileGrid = document.getElementById('fileGrid');

/* INICIO DE FUNÇÃO DE carregar_arquivos; busca as referências no Supabase, destranca as cápsulas e desencripta os metadados dos ficheiros */
export async function carregarArquivos() {
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return;

    fileGrid.innerHTML = '<p style="color: var(--text-muted); grid-column: 1 / -1;">Buscando e a desencriptar ficheiros...</p>';

    try {
        // Busca a tabela de ficheiros e junta a cápsula de acesso restrita do utilizador
        const { data: arquivos, error } = await supabase
            .from('arquivos')
            .select(`
                id,
                tamanho_bytes,
                data_criacao,
                nome_original_criptografado,
                acessos_arquivos ( chave_aes_criptografada )
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
                
                const capsulaBase64 = file.acessos_arquivos[0].chave_aes_criptografada;

                // Destranca a Chave AES com a Chave Privada RSA
                const aesKeyBuffer = await window.crypto.subtle.decrypt(
                    { name: "RSA-OAEP" },
                    window.chavePrivadaUsuario,
                    base64ToBuffer(capsulaBase64)
                );

                const aesKey = await window.crypto.subtle.importKey(
                    "raw", aesKeyBuffer, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
                );

                // Desencripta o pacote do nome do ficheiro
                const nomePacote = JSON.parse(file.nome_original_criptografado);
                const nomeDecodedBuffer = await window.crypto.subtle.decrypt(
                    { name: "AES-GCM", iv: base64ToBuffer(nomePacote.iv) },
                    aesKey,
                    base64ToBuffer(nomePacote.dado)
                );
                
                const nomeReal = new TextDecoder().decode(nomeDecodedBuffer);
                const tamanhoMB = (file.tamanho_bytes / (1024 * 1024)).toFixed(2);

                const card = document.createElement('div');
                card.style.cssText = "background: var(--bg-surface); padding: 15px; border-radius: 8px; border: 1px solid var(--border); display: flex; flex-direction: column; justify-content: space-between;";
                card.innerHTML = `
                    <div>
                        <h4 style="margin: 0 0 10px 0; color: var(--accent); word-break: break-all;">📄 ${nomeReal}</h4>
                        <p style="margin: 0; font-size: 0.85em; color: var(--text-muted);">Tamanho: ${tamanhoMB} MB</p>
                    </div>
                    <p style="margin: 15px 0 0 0; font-size: 0.75em; color: var(--text-muted); text-align: right;">${new Date(file.data_criacao).toLocaleDateString()}</p>
                `;
                fileGrid.appendChild(card);

            } catch (decryptionError) {
                console.error("Ficheiro Ilegível", file.id, decryptionError);
                const cardErro = document.createElement('div');
                cardErro.style.cssText = "background: var(--bg-surface); padding: 15px; border-radius: 8px; border: 1px solid var(--danger);";
                cardErro.innerHTML = `<h4 style="margin: 0; color: var(--danger);">⚠️ Arquivo Corrompido</h4><p style="margin: 5px 0 0 0; font-size: 0.85em; color: var(--text-muted);">Falha de integridade criptográfica.</p>`;
                fileGrid.appendChild(cardErro);
            }
        }
    } catch (err) {
        console.error("Erro na grelha:", err);
        fileGrid.innerHTML = `<p style="color: var(--danger); grid-column: 1 / -1;">Falha ao comunicar com o Supabase.</p>`;
    }
}

/* INICIO DE FUNÇÃO DE orquestrar_upload; executa a geração de chaves E2EE, criptografa metadados e envia para as tabelas do Supabase */
btnUpload.addEventListener('click', async () => {
    if (fileInput.files.length === 0) return alert("Selecione um ficheiro primeiro.");
    
    const session = await verificarSessao();
    if (!session || !window.chavePrivadaUsuario) return alert("Sessão inválida. Faça login novamente.");

    const file = fileInput.files[0];
    btnUpload.disabled = true;

    try {
        uploadStatus.textContent = "Passo 1/4: Gerando chave AES...";
        const aesKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);

        uploadStatus.textContent = "Passo 2/4: Criptografando metadados...";
        const ivNome = window.crypto.getRandomValues(new Uint8Array(12));
        const nomeCriptografado = await window.crypto.subtle.encrypt(
            { name: "AES-GCM", iv: ivNome }, aesKey, new TextEncoder().encode(file.name)
        );
        const pacoteNome = JSON.stringify({ iv: bufferToBase64(ivNome), dado: bufferToBase64(nomeCriptografado) });

        const hashBuffer = await window.crypto.subtle.digest('SHA-256', await file.slice(0, 1024).arrayBuffer());
        const hashHex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

        uploadStatus.textContent = "Passo 3/4: Criando cápsula RSA...";
        const { data: userData, error: userError } = await supabase.from('usuarios').select('chave_publica').eq('id', session.user.id).single();
        if (userError) throw userError;

        const pubKeyRSA = await window.crypto.subtle.importKey(
            "spki", base64ToBuffer(userData.chave_publica), { name: "RSA-OAEP", hash: "SHA-256" }, true, ["encrypt"]
        );

        const aesKeyRaw = await window.crypto.subtle.exportKey("raw", aesKey);
        const capsulaAES = await window.crypto.subtle.encrypt({ name: "RSA-OAEP" }, pubKeyRSA, aesKeyRaw);

        uploadStatus.textContent = "Passo 4/4: Registrando no banco...";
        const { data: arquivoRecord, error: arquivoError } = await supabase.from('arquivos')
            .insert([{ dono_id: session.user.id, nome_original_criptografado: pacoteNome, tamanho_bytes: file.size, hash_sha256: hashHex, mime_type_criptografado: JSON.stringify({ tipo: file.type }) }])
            .select('id').single();
        if (arquivoError) throw arquivoError;

        const { error: acessoError } = await supabase.from('acessos_arquivos')
            .insert([{ arquivo_id: arquivoRecord.id, usuario_id: session.user.id, chave_aes_criptografada: bufferToBase64(capsulaAES) }]);
        if (acessoError) throw acessoError;

        uploadStatus.style.color = "var(--success)";
        uploadStatus.textContent = "✅ Sucesso! Ficheiro registado.";
        fileInput.value = '';
        
        await carregarArquivos(); // Atualiza a grelha imediatamente

    } catch (err) {
        uploadStatus.style.color = "var(--danger)";
        uploadStatus.textContent = "Erro: " + err.message;
    } finally {
        btnUpload.disabled = false;
        setTimeout(() => uploadStatus.textContent = '', 5000);
    }
});

// Listener para disparar o carregamento da grelha assim que o login for concluído
window.addEventListener('cofreDestrancado', carregarArquivos);