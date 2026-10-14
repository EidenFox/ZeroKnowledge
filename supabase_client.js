import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm'
import { CONFIG } from './config.js'

export const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY, {
    auth: {
        storage: window.sessionStorage,
        autoRefreshToken: true,
        persistSession: true,
        detectSessionInUrl: false
    }
});

export async function registrarUsuario(email, senha, chavePublicaBase64, chavePrivadaEncriptadaBase64, metadadosDerivacao) {
    try {
        const { data: authData, error: authError } = await supabase.auth.signUp({
            email: email,
            password: senha,
        });

        if (authError) throw authError;
        if (!authData.user) throw new Error("Falha ao criar usuário no Auth.");

        const { error: dbError } = await supabase
            .from('usuarios')
            .insert([{
                id: authData.user.id,
                email: email,
                chave_publica: chavePublicaBase64,
                chave_privada_criptografada: chavePrivadaEncriptadaBase64,
                metadados_derivacao: metadadosDerivacao
            }]);

        if (dbError) throw dbError;

        return { sucesso: true, usuario: authData.user };
    } catch (error) {
        console.error("Erro no registro:", error);
        return { sucesso: false, erro: error.message };
    }
}

export async function loginUsuario(email, senha) {
    try {
        const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
            email: email,
            password: senha,
        });

        if (authError) throw authError;

        const { data: userData, error: dbError } = await supabase
            .from('usuarios')
            .select('chave_privada_criptografada, metadados_derivacao, chave_publica, aprovado')
            .eq('id', authData.user.id)
            .single();

        if (dbError) throw dbError;

        return { 
            sucesso: true, 
            usuario: authData.user, 
            dados_criptograficos: userData 
        };
    } catch (error) {
        console.error("Erro no login:", error);
        return { sucesso: false, erro: error.message };
    }
}

// esta função checa se já existe um token JWT válido ativo no navegador para evitar re-login manual
export async function verificarSessao() {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
        console.error("Erro ao verificar sessão:", error);
        return null;
    }
    return data.session;
}

// encerra a sessão ativa e limpa os tokens do navegador
export async function logoutUsuario() {
    const { error } = await supabase.auth.signOut();
    if (error) console.error("Erro no logout:", error);
}