import { doc, getDoc, setDoc, serverTimestamp, collection, onSnapshot, updateDoc } from 'firebase/firestore';
import { db } from './firebase.js';
import { ROOMS, VARS } from './config.js';
import { esc } from './stats.js';

function roomForm(room) {
  const lim = room.limits;
  const field = (v, k, label) =>
    `<label>${label} (${VARS[v].unit})<input type="number" step="0.1" name="${v}.${k}" value="${lim[v][k]}" required /></label>`;
  return `
    <form class="card limits" data-room="${room.id}" novalidate>
      <h2>${esc(room.name)}</h2>
      <div class="form-grid">
        <fieldset><legend>Temperatura</legend>${field('temperature', 'min', 'Mínima')}${field('temperature', 'max', 'Máxima')}</fieldset>
        <fieldset><legend>Umidade</legend>${field('humidity', 'min', 'Mínima')}${field('humidity', 'max', 'Máxima')}</fieldset>
      </div>
      <p class="error" role="alert" hidden></p>
      <p class="ok-text" role="status" hidden></p>
      <button class="btn primary" type="submit">Salvar limites</button>
    </form>`;
}

export function mountSettings(view, { user, store }) {
  view.innerHTML = `
    <div class="grid-2" id="forms"></div>
    <section class="card"><h2>Usuários</h2>
      <div class="table-wrap"><table><thead><tr><th>E-mail</th><th>Papel</th></tr></thead><tbody id="users"></tbody></table></div>
      <p class="muted small">Administradores configuram limites e papéis; usuários só visualizam.</p>
    </section>`;
  const forms = view.querySelector('#forms');
  const usersBody = view.querySelector('#users');

  // Le os limites gravados uma vez (evita sobrescrever com o padrao antes do Firestore responder).
  let alive = true;
  forms.innerHTML = '<p class="muted">Carregando…</p>';
  Promise.all(ROOMS.map((r) => getDoc(doc(db, 'rooms', r.id)))).then((docs) => {
    if (!alive) return;
    forms.innerHTML = ROOMS.map((r, i) => {
      const live = store.state.rooms[r.id];
      const limits = docs[i].data()?.limits ?? live.limits;
      return roomForm({ ...live, limits });
    }).join('');
    forms.querySelectorAll('form').forEach((f) => f.addEventListener('submit', (e) => save(e, f)));
  }).catch((e) => { forms.innerHTML = `<p class="error">Erro ao carregar limites: ${esc(e.message)}</p>`; });

  async function save(e, form) {
    e.preventDefault();
    const err = form.querySelector('.error');
    const ok = form.querySelector('.ok-text');
    err.hidden = ok.hidden = true;
    const num = (name) => Number(form.elements[name].value);
    const limits = {
      temperature: { min: num('temperature.min'), max: num('temperature.max') },
      humidity: { min: num('humidity.min'), max: num('humidity.max') },
    };
    const values = Object.values(limits).flatMap((l) => [l.min, l.max]);
    if (values.some((v) => !Number.isFinite(v))) return show(err, 'Preencha todos os campos com números.');
    if (limits.temperature.min >= limits.temperature.max) return show(err, 'Temperatura: o mínimo deve ser menor que o máximo.');
    if (limits.humidity.min >= limits.humidity.max) return show(err, 'Umidade: o mínimo deve ser menor que o máximo.');
    if (limits.humidity.min < 0 || limits.humidity.max > 100) return show(err, 'Umidade deve estar entre 0 e 100 %.');
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await setDoc(doc(db, 'rooms', form.dataset.room), {
        name: store.state.rooms[form.dataset.room].name,
        limits,
        updatedAt: serverTimestamp(),
        updatedBy: user.email,
      }, { merge: true });
      show(ok, 'Limites salvos.');
    } catch (ex) {
      show(err, ex.code === 'permission-denied' ? 'Sem permissão para alterar limites.' : `Erro ao salvar: ${ex.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  const show = (el, text) => { el.textContent = text; el.hidden = false; };

  const unsubUsers = onSnapshot(collection(db, 'users'), (snap) => {
    usersBody.innerHTML = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(a.email).localeCompare(String(b.email)))
      .map((u) => `<tr><td>${esc(u.email)}</td><td>
        <select data-uid="${esc(u.id)}" ${u.id === user.uid ? 'disabled title="Você não pode alterar o próprio papel"' : ''}>
          <option value="user"${u.role === 'user' ? ' selected' : ''}>Usuário</option>
          <option value="admin"${u.role === 'admin' ? ' selected' : ''}>Administrador</option>
        </select></td></tr>`)
      .join('');
  }, (e) => console.error('users', e));

  usersBody.addEventListener('change', async (e) => {
    const sel = e.target.closest('select[data-uid]');
    if (!sel) return;
    sel.disabled = true;
    try {
      await updateDoc(doc(db, 'users', sel.dataset.uid), { role: sel.value });
    } catch (ex) {
      alert('Não foi possível alterar o papel: ' + ex.message);
    }
    sel.disabled = false;
  });

  return () => { alive = false; unsubUsers(); };
}
