import { registrarUsuario, loginUsuario, verificarSessao, logoutUsuario } from './supabase_client.js';

// converte entre Base64 e ArrayBuffer para trânsito de chaves
function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

function base64ToBuffer(base64) {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes.buffer;
}

// gera e deriva chaves assimétricas para proteger a identidade do utilizador
async function gerarParChavesRSA() {
    return await window.crypto.subtle.generateKey(
        { name: "RSA-OAEP", modulusLength: 4096, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
        true, ["encrypt", "decrypt"]
    );
}

async function derivarChaveDaSenha(senha, salt) {
    const enc = new TextEncoder();
    const senhaKey = await window.crypto.subtle.importKey("raw", enc.encode(senha), { name: "PBKDF2" }, false, ["deriveBits", "deriveKey"]);
    return await window.crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: salt, iterations: 300000, hash: "SHA-256" },
        senhaKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
    );
}

window.chavePrivadaUsuario = null;

const modal = document.getElementById('authModal');
const navAuthBtn = document.getElementById('navAuthBtn');
const closeModalBtn = document.getElementById('closeModalBtn');
const toggleLogin = document.getElementById('toggleLoginMode');
const toggleRegister = document.getElementById('toggleRegisterMode');
const authForm = document.getElementById('authForm');
const modalTitle = document.getElementById('modalTitle');
const authSubmitBtn = document.getElementById('authSubmitBtn');
const authMessage = document.getElementById('authMessage');
const userInfo = document.getElementById('userInfo');
const userEmailDisplay = document.getElementById('userEmailDisplay');
const navLogoutBtn = document.getElementById('navLogoutBtn');
const unauthenticatedView = document.getElementById('unauthenticatedView');
const authenticatedView = document.getElementById('authenticatedView');

let isLoginMode = true;

// alterna a visibilidade dos componentes com base no estado de autenticação
function setViewState(isLoggedIn, email = '') {
    if (isLoggedIn) {
        navAuthBtn.style.display = 'none';
        userInfo.style.display = 'flex';
        userInfo.style.alignItems = 'center';
        userInfo.style.gap = '15px';
        userEmailDisplay.textContent = email;
        unauthenticatedView.classList.remove('active');
        authenticatedView.classList.add('active');
    } else {
        navAuthBtn.style.display = 'block';
        userInfo.style.display = 'none';
        unauthenticatedView.classList.add('active');
        authenticatedView.classList.remove('active');
        window.chavePrivadaUsuario = null;
    }
}

navAuthBtn.addEventListener('click', () => {
    modal.classList.add('active');
    authMessage.textContent = '';
});

closeModalBtn.addEventListener('click', () => {
    modal.classList.remove('active');
});

toggleLogin.addEventListener('click', () => {
    isLoginMode = true;
    toggleLogin.classList.add('active');
    toggleRegister.classList.remove('active');
    modalTitle.textContent = 'Login';
    authSubmitBtn.textContent = 'Entrar no Cofre';
    authMessage.textContent = '';
});

toggleRegister.addEventListener('click', () => {
    isLoginMode = false;
    toggleRegister.classList.add('active');
    toggleLogin.classList.remove('active');
    modalTitle.textContent = 'Criar Cofre';
    authSubmitBtn.textContent = 'Registrar e Gerar Chaves';
    authMessage.textContent = '';
});

navLogoutBtn.addEventListener('click', async () => {
    await logoutUsuario();
    setViewState(false);
});

//  orquestra o registo/login na base de dados e executa a matemática Zero-Knowledge
authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('authEmail').value;
    const senha = document.getElementById('authPassword').value;

    authSubmitBtn.disabled = true;
    authMessage.style.color = 'var(--text-muted)';
    authMessage.textContent = 'Processando criptografia RSA-4096...';

    try {
        if (isLoginMode) {
            const res = await loginUsuario(email, senha);
            if (!res.sucesso) throw new Error(res.erro);

            if (res.dados_criptograficos.aprovado === false) {
                await logoutUsuario();
                throw new Error("A sua conta está PENDENTE de aprovação pelo administrador.");
            }

            const { chave_privada_criptografada, metadados_derivacao } = res.dados_criptograficos;
            const saltBuffer = base64ToBuffer(metadados_derivacao.salt_base64);
            const ivBuffer = base64ToBuffer(metadados_derivacao.iv_base64);

            const aesDerivada = await derivarChaveDaSenha(senha, saltBuffer);
            const privKeyEncryptedBuffer = base64ToBuffer(chave_privada_criptografada);

            const privKeyBuffer = await window.crypto.subtle.decrypt(
                { name: "AES-GCM", iv: new Uint8Array(ivBuffer) },
                aesDerivada,
                privKeyEncryptedBuffer
            );

            window.chavePrivadaUsuario = await window.crypto.subtle.importKey(
                "pkcs8", privKeyBuffer, { name: "RSA-OAEP", hash: "SHA-256" }, true, ["decrypt"]
            );

            modal.classList.remove('active');
            setViewState(true, res.usuario.email);
            window.dispatchEvent(new Event('cofreDestrancado'));

        } else {
            const parChaves = await gerarParChavesRSA();
            const pubKeyBuffer = await window.crypto.subtle.exportKey("spki", parChaves.publicKey);
            const chavePublicaBase64 = bufferToBase64(pubKeyBuffer);
            const privKeyBuffer = await window.crypto.subtle.exportKey("pkcs8", parChaves.privateKey);

            const salt = window.crypto.getRandomValues(new Uint8Array(16));
            const iv = window.crypto.getRandomValues(new Uint8Array(12));
            const chaveAESDerivada = await derivarChaveDaSenha(senha, salt);

            const privKeyCriptografadaBuffer = await window.crypto.subtle.encrypt(
                { name: "AES-GCM", iv: iv },
                chaveAESDerivada,
                privKeyBuffer
            );

            const metadadosDerivacao = {
                algoritmo_derivacao: "PBKDF2",
                iteracoes: 300000,
                salt_base64: bufferToBase64(salt),
                iv_base64: bufferToBase64(iv)
            };

            const res = await registrarUsuario(email, senha, chavePublicaBase64, bufferToBase64(privKeyCriptografadaBuffer), metadadosDerivacao);
            if (!res.sucesso) throw new Error(res.erro);

            await logoutUsuario();

            authMessage.style.color = 'var(--success)';
            authMessage.textContent = "Cofre criado com sucesso! O acesso está PENDENTE de aprovação.";

            document.getElementById('authEmail').value = '';
            document.getElementById('authPassword').value = '';
        }
    } catch (err) {
        authMessage.style.color = 'var(--danger)';
        authMessage.textContent = err.message || "Erro durante o processo criptográfico.";
        console.error(err);
    } finally {
        authSubmitBtn.disabled = false;
    }
});

// impede o acesso com tokens residuais (JWT) que não possuam a chave privada mapeada na memória volátil
window.addEventListener('DOMContentLoaded', async () => {
    const session = await verificarSessao();
    if (session && !window.chavePrivadaUsuario) {
        await logoutUsuario();
        setViewState(false);
        authMessage.style.color = 'var(--danger)';
        authMessage.textContent = "Cofre trancado por segurança. Autentique-se para destrancar.";
        modal.classList.add('active');
    } else {
        setViewState(false);
    }
});