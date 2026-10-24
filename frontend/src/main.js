import './style.css';
import { watchSession, renderLogin, logout } from './auth.js';
import { createLiveStore, mountLive, renderAlertBar } from './live.js';
import { mountHistory } from './history.js';
import { mountSettings } from './settings.js';
import { esc } from './stats.js';

const root = document.getElementById('app');
let current = null; // { uid, role, cleanup }

const TABS = [
  { id: 'live', label: 'Tempo real', mount: mountLive },
  { id: 'history', label: 'Histórico', mount: mountHistory },
  { id: 'settings', label: 'Configurações', mount: mountSettings, adminOnly: true },
];

function renderShell({ user, role }) {
  const tabs = TABS.filter((t) => !t.adminOnly || role === 'admin');
  root.innerHTML = `
    <header class="topbar">
      <strong class="brand">🌡️ Monitor de Salas</strong>
      <nav class="tabs" role="tablist">
        ${tabs.map((t, i) => `<button class="tab${i ? '' : ' active'}" data-tab="${t.id}" role="tab">${t.label}</button>`).join('')}
      </nav>
      <div class="user">
        <span class="muted">${esc(user.email)}</span>
        <span class="pill ${role}">${role === 'admin' ? 'Administrador' : 'Usuário'}</span>
        <button class="btn" id="logout">Sair</button>
      </div>
    </header>
    <div id="alert-bar" class="alert-bar" role="alert" hidden></div>
    <main id="view" class="view"></main>`;

  const view = root.querySelector('#view');
  const alertBar = root.querySelector('#alert-bar');
  const store = createLiveStore(); // fica ativo em todas as abas: o alerta aparece sempre
  const stopAlert = store.subscribe(() => renderAlertBar(alertBar, store.state));
  let unmount = null;

  const show = (id) => {
    unmount?.();
    view.innerHTML = '';
    root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === id));
    unmount = tabs.find((t) => t.id === id).mount(view, { user, role, store });
  };

  root.querySelectorAll('.tab').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
  root.querySelector('#logout').addEventListener('click', logout);
  show('live');

  return () => {
    unmount?.();
    stopAlert();
    store.stop();
  };
}

watchSession((session) => {
  const same = session && current && current.uid === session.user.uid && current.role === session.role;
  if (same) return;
  current?.cleanup?.();
  current = null;
  if (!session) return renderLogin(root);
  current = { uid: session.user.uid, role: session.role, cleanup: renderShell(session) };
});
