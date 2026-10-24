import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import { doc, onSnapshot, setDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase.js';

const MESSAGES = {
  'auth/invalid-credential': 'E-mail ou senha incorretos.',
  'auth/invalid-email': 'E-mail inválido.',
  'auth/email-already-in-use': 'Este e-mail já está cadastrado.',
  'auth/weak-password': 'A senha precisa ter ao menos 6 caracteres.',
  'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco.',
  'auth/network-request-failed': 'Sem conexão com a internet.',
};

// Observa login + papel. cb(null) = deslogado; cb({ user, role }) = logado.
export function watchSession(cb) {
  let unsubProfile = null;
  return onAuthStateChanged(auth, (user) => {
    unsubProfile?.();
    unsubProfile = null;
    if (!user) return cb(null);
    const ref = doc(db, 'users', user.uid);
    unsubProfile = onSnapshot(
      ref,
      async (snap) => {
        if (!snap.exists()) {
          // primeiro acesso: perfil sempre nasce como 'user' (as regras exigem)
          await setDoc(ref, { email: user.email, role: 'user', createdAt: serverTimestamp() });
          return;
        }
        cb({ user, role: snap.data().role === 'admin' ? 'admin' : 'user' });
      },
      (err) => console.error('perfil', err),
    );
  });
}

export function renderLogin(root) {
  root.innerHTML = `
    <main class="login">
      <form id="login-form" class="card login-card" novalidate>
        <h1>Monitor de Salas</h1>
        <p class="muted">Temperatura e umidade em tempo real</p>
        <div class="tabs" role="tablist">
          <button type="button" class="tab active" data-mode="login">Entrar</button>
          <button type="button" class="tab" data-mode="register">Criar conta</button>
        </div>
        <label>E-mail<input type="email" name="email" autocomplete="email" required /></label>
        <label>Senha<input type="password" name="password" autocomplete="current-password" minlength="6" required /></label>
        <p id="login-error" class="error" role="alert" hidden></p>
        <button class="btn primary" type="submit">Entrar</button>
      </form>
    </main>`;
  const form = root.querySelector('#login-form');
  const errorEl = root.querySelector('#login-error');
  const submit = form.querySelector('button[type=submit]');
  let mode = 'login';

  form.querySelectorAll('.tab').forEach((t) =>
    t.addEventListener('click', () => {
      mode = t.dataset.mode;
      form.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
      submit.textContent = mode === 'login' ? 'Entrar' : 'Criar conta';
      form.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
      errorEl.hidden = true;
    }),
  );

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    submit.disabled = true;
    try {
      const fn = mode === 'login' ? signInWithEmailAndPassword : createUserWithEmailAndPassword;
      await fn(auth, form.email.value.trim(), form.password.value);
    } catch (err) {
      errorEl.textContent = MESSAGES[err.code] || 'Não foi possível entrar. Tente novamente.';
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

export const logout = () => signOut(auth);
