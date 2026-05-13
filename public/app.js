/* =============================================================
   Salesforce Connector — Frontend  v1.1
   Connections are stored in localStorage, namespaced per user.
   ============================================================= */

// ----- Flow catalogue -------------------------------------------------------
const FLOWS = [
  {
    id: 'web-server', name: 'Web Server', tag: 'authorization_code', badge: 'Interactive',
    description: `Standard <strong>three-legged OAuth</strong> with a client secret.
      A popup opens Salesforce's login page; on success the auth code is exchanged
      server-side for tokens. Best for trusted backend apps.<br><br>
      Add <code>http://localhost:3000/api/callback</code> as a callback URL in your Connected App.`,
    fields: ['clientId', 'clientSecret', 'scope'],
  },
  {
    id: 'web-server-pkce', name: 'Web Server + PKCE', tag: 'auth_code + pkce', badge: 'Interactive',
    description: `Authorization Code Flow with <strong>PKCE</strong> (S256). Use for
      single-page apps, mobile, or any public client that cannot keep a secret.
      The client secret is optional — leave it blank for true public-client mode.
      Required by Salesforce for SPAs since Spring '25.`,
    fields: ['clientId', 'clientSecret', 'scope'],
    optionalFields: ['clientSecret'],
  },
  {
    id: 'user-agent', name: 'User-Agent (Implicit)', tag: 'response_type=token',
    badge: 'Interactive', badgeKind: 'warn',
    description: `Legacy <strong>implicit flow</strong>. Salesforce returns the access token
      directly in the URL fragment. Considered insecure and being phased out in favor of PKCE.
      Included here for completeness and backward compatibility.`,
    fields: ['clientId', 'scope'],
  },
  {
    id: 'jwt-bearer', name: 'JWT Bearer', tag: 'grant=jwt-bearer', badge: 'Headless',
    description: `<strong>Server-to-server</strong> flow with no user interaction. Sign a JWT
      with your private key; Salesforce verifies it against the certificate uploaded to the
      Connected App. The <code>sub</code> (username) must have been pre-authorized in the
      Connected App's OAuth policies.`,
    fields: ['clientId', 'username', 'privateKey'],
  },
  {
    id: 'client-credentials', name: 'Client Credentials', tag: 'grant=client_credentials', badge: 'Headless',
    description: `Pure machine-to-machine OAuth. No user identity in the request — the Connected
      App must have an integration user configured under <code>OAuth Policies → Run As</code>.
      Available in Salesforce since Winter '23.`,
    fields: ['clientId', 'clientSecret'],
  },
  {
    id: 'username-password', name: 'Username-Password', tag: 'grant=password',
    badge: 'Legacy', badgeKind: 'warn',
    description: `Direct exchange of username + password for an access token. Salesforce has
      <strong>deprecated</strong> this flow and disabled it by default on new orgs. Useful only
      for quick scripts or legacy automation. The <code>Security Token</code> is appended to
      the password for non-whitelisted IPs.`,
    fields: ['clientId', 'clientSecret', 'username', 'password', 'securityToken'],
    optionalFields: ['securityToken'],
  },
  {
    id: 'device', name: 'Device Flow', tag: 'response_type=device_code', badge: 'Interactive',
    description: `For input-constrained devices (TVs, CLI tools, IoT). The server gets a short
      user code and a verification URL; the user authorises on a separate browser; this app polls
      until the token is issued. <strong>Public client</strong> on the Connected App must be enabled.`,
    fields: ['clientId', 'scope'],
  },
  {
    id: 'refresh-token', name: 'Refresh Token', tag: 'grant=refresh_token', badge: 'Renewal',
    description: `Trade a previously stored refresh token for a fresh access token. Use this to
      re-establish a session after a token expires without prompting the user again. Requires
      <code>refresh_token</code> in the original scopes.`,
    fields: ['clientId', 'clientSecret', 'refreshToken'],
    optionalFields: ['clientSecret'],
  },
];

// ----- Field definitions ----------------------------------------------------
const FIELDS = {
  clientId:      { label: 'Client ID (Consumer Key)',       type: 'text',     placeholder: '3MVG9…',                    required: true  },
  clientSecret:  { label: 'Client Secret (Consumer Secret)',type: 'password', placeholder: 'Optional for public clients', required: true  },
  username:      { label: 'Username',                       type: 'text',     placeholder: 'integration@example.com',    required: true  },
  password:      { label: 'Password',                       type: 'password', placeholder: 'Salesforce password',        required: true  },
  securityToken: { label: 'Security Token',                 type: 'password', placeholder: 'Appended to password (optional)',
    required: false, hint: 'Reset under <em>Settings → Reset My Security Token</em>.' },
  privateKey:    { label: 'Private Key (PEM)',              type: 'textarea', placeholder: '-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----',
    required: true, keyArea: true, hint: 'Matches the certificate uploaded to your Connected App.' },
  refreshToken:  { label: 'Refresh Token',                  type: 'password', placeholder: '5Aep861…',                  required: true  },
  scope:         { label: 'Scopes',                         type: 'text',     placeholder: 'api refresh_token',
    required: false, hint: 'Space-separated. Default: <code>api refresh_token</code>' },
};

// ----- State ----------------------------------------------------------------
const state = {
  selectedFlow:     'web-server',
  tokens:           null,
  instanceUrl:      null,
  devicePollHandle: null,
  user:             null,   // Google user object, or null for guest
  googleEnabled:    false,
  savedConnections: [],
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// localStorage helpers — namespaced per user so connections are private
// ---------------------------------------------------------------------------

function storageKey() {
  return state.user ? `sf-connections-google-${state.user.id}` : 'sf-connections-guest';
}

function loadFromStorage() {
  try { return JSON.parse(localStorage.getItem(storageKey()) || '[]'); }
  catch { return []; }
}

function persistToStorage(conns) {
  localStorage.setItem(storageKey(), JSON.stringify(conns));
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  renderFlowGrid();
  selectFlow(state.selectedFlow);
  bindOrgRadios();
  bindButtons();
  listenForAuthPopupMessages();

  // Auth check must come first — it sets state.user which affects the storage key
  await checkAuth();
  await pingHealth();
  renderSavedConnections();

  // Toast if Google just redirected back
  const params = new URLSearchParams(location.search);
  if (params.get('auth') === 'success') {
    toast(`Signed in as ${state.user?.name || 'Google user'}`, 'ok');
    history.replaceState({}, '', '/');
  } else if (params.get('auth') === 'failed') {
    toast('Google sign-in failed. Try again.', 'err');
    history.replaceState({}, '', '/');
  }
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

async function checkAuth() {
  try {
    const r    = await fetch('/auth/me');
    const data = await r.json();
    state.user          = data.user;
    state.googleEnabled = data.googleEnabled;
  } catch {
    state.user          = null;
    state.googleEnabled = false;
  }
  renderAuthUI();
}

function renderAuthUI() {
  const el = $('#topbarAuth');
  if (!el) return;

  if (state.user) {
    // Logged in with Google
    el.innerHTML = `
      <div class="auth-user">
        ${state.user.avatar
          ? `<img class="auth-avatar" src="${escapeHtml(state.user.avatar)}" alt="">`
          : `<div class="auth-avatar-placeholder">${escapeHtml(state.user.name[0] || '?')}</div>`}
        <span class="auth-name">${escapeHtml(state.user.name)}</span>
        <button class="btn-ghost btn-sm" id="logoutBtn">Sign out</button>
      </div>`;
    $('#logoutBtn')?.addEventListener('click', doLogout);
  } else if (state.googleEnabled) {
    // Guest + Google available
    el.innerHTML = `
      <a href="/auth/google" class="btn-google">
        <svg viewBox="0 0 24 24" width="16" height="16" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
        </svg>
        Sign in with Google
      </a>`;
  } else {
    // Guest, no Google configured
    el.innerHTML = `<span class="badge-guest">Guest</span>`;
  }
}

async function doLogout() {
  try {
    await fetch('/auth/logout', { method: 'POST' });
    state.user = null;
    renderAuthUI();
    renderSavedConnections();
    log('info', 'Signed out — showing guest connections');
    toast('Signed out', 'ok');
  } catch (e) {
    toast('Sign-out failed: ' + e.message, 'err');
  }
}

// ---------------------------------------------------------------------------
// Health ping
// ---------------------------------------------------------------------------

async function pingHealth() {
  try {
    const r = await fetch('/api/health');
    const d = await r.json();
    $('#callbackUrl').textContent = d.callbackUrl;
    $('#serverDot').classList.add('ok');
  } catch {
    $('#callbackUrl').textContent = 'server unavailable';
    $('#serverDot').classList.add('err');
  }
}

// ---------------------------------------------------------------------------
// Org radios + buttons
// ---------------------------------------------------------------------------

function bindOrgRadios() {
  $$('input[name="orgType"]').forEach((el) => {
    el.addEventListener('change', () => {
      $('#customUrlWrap').classList.toggle('hidden', el.value !== 'custom' || !el.checked);
    });
  });
}

function bindButtons() {
  $('#connectBtn').addEventListener('click', onConnect);
  $('#resetBtn').addEventListener('click', resetAll);
  $('#runQueryBtn').addEventListener('click', runQuery);
  $('#userInfoBtn').addEventListener('click', getUserInfo);
  $('#clearLogBtn').addEventListener('click', () => ($('#log').innerHTML = ''));

  $('#saveBtn').addEventListener('click', toggleSaveDialog);
  $('#confirmSaveBtn').addEventListener('click', saveConnection);
  $('#cancelSaveBtn').addEventListener('click', () => {
    $('#saveDialog').classList.add('hidden');
    $('#connName').value = '';
  });
  $('#connName').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveConnection();
    if (e.key === 'Escape') { $('#saveDialog').classList.add('hidden'); $('#connName').value = ''; }
  });
}

// ---------------------------------------------------------------------------
// Flow rendering
// ---------------------------------------------------------------------------

function renderFlowGrid() {
  const grid = $('#flowGrid');
  grid.innerHTML = FLOWS.map((f) => `
    <button class="flow-card" data-flow="${f.id}">
      <span class="flow-badge ${f.badgeKind === 'warn' ? 'warn' : ''}">${f.badge}</span>
      <div class="flow-title">${f.name}</div>
      <div class="flow-tag">${f.tag}</div>
    </button>`).join('');
  $$('.flow-card', grid).forEach((card) => {
    card.addEventListener('click', () => selectFlow(card.dataset.flow));
  });
}

function selectFlow(id) {
  state.selectedFlow = id;
  const flow = FLOWS.find((f) => f.id === id);
  $$('.flow-card').forEach((c) => c.classList.toggle('selected', c.dataset.flow === id));
  $('#flowDetail').innerHTML = flow.description;
  renderCredentialsForm(flow);
}

function renderCredentialsForm(flow) {
  const container = $('#credentialsForm');
  const html = flow.fields.map((f) => fieldMarkup(f, flow)).join('');
  container.innerHTML = html ||
    '<div class="empty-state"><p>This flow needs no credentials. Click <strong>Connect</strong> to start.</p></div>';
}

function fieldMarkup(name, flow) {
  const def = FIELDS[name];
  if (!def) return '';
  const isOptional = flow.optionalFields?.includes(name) || !def.required;
  const id = `f-${name}`;
  const reqMark = isOptional ? '' : '<span class="req">*</span>';
  const hint = def.hint ? `<div class="hint">${def.hint}</div>` : '';
  if (def.type === 'textarea') {
    return `<div class="field">
      <label for="${id}">${def.label}${reqMark}</label>
      <textarea id="${id}" name="${name}" placeholder="${def.placeholder}" class="${def.keyArea ? 'key-area' : ''}" spellcheck="false"></textarea>
      ${hint}</div>`;
  }
  return `<div class="field">
    <label for="${id}">${def.label}${reqMark}</label>
    <input id="${id}" name="${name}" type="${def.type}" placeholder="${def.placeholder}" autocomplete="off" spellcheck="false">
    ${hint}</div>`;
}

// ---------------------------------------------------------------------------
// Connect dispatcher
// ---------------------------------------------------------------------------

async function onConnect() {
  const flow = FLOWS.find((f) => f.id === state.selectedFlow);
  const params = collectFormValues(flow);
  const orgType   = $$('input[name="orgType"]').find((r) => r.checked).value;
  const customUrl = $('#customUrl').value;

  for (const field of flow.fields) {
    const isOptional = flow.optionalFields?.includes(field) || !FIELDS[field].required;
    if (!isOptional && !params[field]) {
      toast(`${FIELDS[field].label} is required.`, 'err');
      return;
    }
  }

  setBusy(true);
  log('info', `Starting <strong>${flow.name}</strong> flow…`);

  try {
    const resp = await fetch('/api/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ flow: flow.id, orgType, customUrl, ...params }),
    });
    const data = await resp.json();

    if (data.authUrl) {
      log('info', `Opening Salesforce login window… <span class="mono">${flow.id}</span>`);
      openAuthPopup(data.authUrl);
      return;
    }
    if (data.deviceCode) { renderDeviceCode(data, flow, { orgType, customUrl, ...params }); return; }
    if (data.tokens)     { onTokensReceived(data.tokens); }
    else                 { onAuthError(data); }
  } catch (e) {
    onAuthError({ error: e.message });
  } finally {
    setBusy(false);
  }
}

function collectFormValues(flow) {
  const obj = {};
  for (const f of flow.fields) {
    const el = document.querySelector(`[name="${f}"]`);
    if (el) obj[f] = el.value.trim();
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Popup management
// ---------------------------------------------------------------------------

let authPopup = null;
function openAuthPopup(url) {
  const w = 540, h = 720;
  const left = window.screenX + (window.outerWidth  - w) / 2;
  const top  = window.screenY + (window.outerHeight - h) / 2;
  authPopup = window.open(url, 'sf-auth',
    `width=${w},height=${h},left=${left},top=${top},toolbar=no,menubar=no`);
  if (!authPopup) { toast('Popup blocked. Allow popups for this site and retry.', 'err'); setBusy(false); }
}

function listenForAuthPopupMessages() {
  window.addEventListener('message', (event) => {
    if (event.data?.type !== 'sf-auth-result') return;
    const { result } = event.data;
    setBusy(false);
    if (result.error)  onAuthError(result);
    else if (result.tokens) onTokensReceived(result.tokens);
  });
}

// ---------------------------------------------------------------------------
// Device flow
// ---------------------------------------------------------------------------

function renderDeviceCode(data, flow, originalParams) {
  const d    = data.deviceCode;
  const body = $('#connBody');
  body.innerHTML = `
    <div class="device-box">
      <div class="mono" style="font-size:.7rem;color:var(--text-dim);letter-spacing:.1em;text-transform:uppercase">Visit this URL on any device</div>
      <a class="device-link" href="${d.verification_uri}" target="_blank" rel="noopener">${d.verification_uri}</a>
      <div class="mono" style="font-size:.7rem;color:var(--text-dim);margin-top:1rem;letter-spacing:.1em;text-transform:uppercase">Enter this code</div>
      <div class="device-code">${d.user_code}</div>
      <div class="device-poll" id="devicePollStatus">Waiting for authorization…</div>
    </div>`;
  $('#connState').textContent = 'Awaiting user';

  const interval = (d.interval || 5) * 1000;
  const expires  = Date.now() + (d.expires_in || 600) * 1000;
  const tick = async () => {
    if (Date.now() > expires) {
      $('#devicePollStatus').textContent = 'Code expired. Reconnect to try again.';
      clearInterval(state.devicePollHandle); return;
    }
    try {
      const r   = await fetch('/api/connect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flow: 'device-poll', orgType: originalParams.orgType,
          customUrl: originalParams.customUrl, clientId: originalParams.clientId, deviceCode: d.device_code }),
      });
      const res = await r.json();
      if (res.tokens)  { clearInterval(state.devicePollHandle); onTokensReceived(res.tokens); return; }
      if (!res.pending){ clearInterval(state.devicePollHandle); onAuthError(res); }
    } catch {} // network blip — keep polling
  };
  state.devicePollHandle = setInterval(tick, interval);
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

function onTokensReceived(tokens) {
  state.tokens      = tokens;
  state.instanceUrl = tokens.instance_url;
  $('#connState').textContent = 'Connected';
  $('#connState').classList.remove('err');
  $('#connState').classList.add('ok');
  renderConnectionDetails(tokens);
  $('#queryCard').hidden = false;
  log('ok', `Connected to <span class="mono">${tokens.instance_url || 'Salesforce'}</span>`);
  toast('Connected to Salesforce', 'ok');
}

function renderConnectionDetails(tokens) {
  const rows = [
    ['Instance',    tokens.instance_url],
    ['Access Token',tokens.access_token],
    ['Refresh Token',tokens.refresh_token],
    ['Identity',    tokens.id],
    ['Issued At',   tokens.issued_at ? new Date(parseInt(tokens.issued_at)).toISOString() : null],
    ['Token Type',  tokens.token_type],
    ['Scope',       tokens.scope],
    ['Signature',   tokens.signature],
  ].filter(([, v]) => v != null);

  $('#connBody').innerHTML = `<div class="kv">
    ${rows.map(([k, v]) => `
      <div class="kv-row">
        <div class="kv-key">${k}</div>
        <div class="kv-val" title="Click to expand">${escapeHtml(String(v))}</div>
        <button class="kv-copy" data-copy="${escapeHtml(String(v))}">copy</button>
      </div>`).join('')}
    </div>`;

  $$('.kv-val',  $('#connBody')).forEach((el) => el.addEventListener('click', () => el.classList.toggle('expanded')));
  $$('.kv-copy', $('#connBody')).forEach((el) => el.addEventListener('click', async () => {
    await navigator.clipboard.writeText(el.dataset.copy);
    const orig = el.textContent; el.textContent = 'copied';
    setTimeout(() => (el.textContent = orig), 1200);
  }));
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

function onAuthError(result) {
  $('#connState').textContent = 'Error';
  $('#connState').classList.add('err');
  $('#connState').classList.remove('ok');
  const errText = result.error || 'Unknown error';
  const raw     = result.raw ? JSON.stringify(result.raw, null, 2) : '';
  $('#connBody').innerHTML = `<div class="result-error">
    <strong>${escapeHtml(errText)}</strong>
    ${raw ? `<pre>${escapeHtml(raw)}</pre>` : ''}
  </div>`;
  log('err', escapeHtml(errText));
  toast(errText, 'err');
}

// ---------------------------------------------------------------------------
// SOQL / userinfo
// ---------------------------------------------------------------------------

async function runQuery() {
  if (!state.tokens) return toast('Not connected.', 'err');
  const query = $('#soql').value.trim();
  if (!query)  return toast('Enter a SOQL query.', 'err');
  const resultBox = $('#queryResult');
  resultBox.innerHTML = `<div class="result-meta"><span>Running…</span></div>`;
  log('info', `SOQL: <span class="mono">${escapeHtml(query)}</span>`);
  try {
    const r = await fetch('/api/query', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceUrl: state.instanceUrl, accessToken: state.tokens.access_token, query }),
    });
    const data = await r.json();
    if (!r.ok) {
      resultBox.innerHTML = `<div class="result-error"><strong>Query failed</strong><pre>${escapeHtml(JSON.stringify(data.error, null, 2))}</pre></div>`;
      log('err', 'Query failed'); return;
    }
    renderQueryTable(data);
    log('ok', `Query returned ${data.totalSize} record${data.totalSize === 1 ? '' : 's'}`);
  } catch (e) {
    resultBox.innerHTML = `<div class="result-error"><strong>${escapeHtml(e.message)}</strong></div>`;
    log('err', e.message);
  }
}

function renderQueryTable(data) {
  const records = data.records || [];
  if (records.length === 0) {
    $('#queryResult').innerHTML = `<div class="result-meta"><span>0 rows</span><span class="mono">totalSize: 0</span></div>
      <div class="empty-state"><p>No records returned.</p></div>`;
    return;
  }
  const cols = Array.from(new Set(records.flatMap((r) => Object.keys(r).filter((k) => k !== 'attributes'))));
  const head = cols.map((c) => `<th>${c}</th>`).join('');
  const rows = records.map((r) => `<tr>${cols.map((c) => `<td>${escapeHtml(formatVal(r[c]))}</td>`).join('')}</tr>`).join('');
  $('#queryResult').innerHTML = `
    <div class="result-meta">
      <span>${records.length} row${records.length === 1 ? '' : 's'} · <span class="mono">${escapeHtml(records[0]?.attributes?.type || '—')}</span></span>
      <span class="mono">totalSize: ${data.totalSize}</span>
    </div>
    <table class="result-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function formatVal(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

async function getUserInfo() {
  if (!state.tokens) return toast('Not connected.', 'err');
  log('info', 'GET /services/oauth2/userinfo');
  try {
    const r    = await fetch('/api/userinfo', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instanceUrl: state.instanceUrl, accessToken: state.tokens.access_token }),
    });
    const data = await r.json();
    if (!r.ok) {
      $('#queryResult').innerHTML = `<div class="result-error"><strong>userinfo failed</strong><pre>${escapeHtml(JSON.stringify(data.error, null, 2))}</pre></div>`;
      log('err', 'userinfo failed'); return;
    }
    const rows = Object.entries(data)
      .filter(([, v]) => typeof v !== 'object' || v === null)
      .map(([k, v]) => `<tr><td><span class="mono">${k}</span></td><td>${escapeHtml(String(v))}</td></tr>`)
      .join('');
    $('#queryResult').innerHTML = `
      <div class="result-meta"><span>User identity</span><span class="mono">/services/oauth2/userinfo</span></div>
      <table class="result-table"><tbody>${rows}</tbody></table>`;
    log('ok', `Identity: ${data.preferred_username || data.email || data.user_id}`);
  } catch (e) { log('err', e.message); }
}

// ---------------------------------------------------------------------------
// Saved Connections (localStorage)
// ---------------------------------------------------------------------------

function renderSavedConnections() {
  const conns     = loadFromStorage();
  state.savedConnections = conns;
  const container = $('#savedConnectionsList');
  const countEl   = $('#savedCount');

  if (!conns.length) {
    const who = state.user ? state.user.name.split(' ')[0] + "'s" : 'Guest';
    countEl.textContent = '';
    container.innerHTML = `<div class="empty-state">
      <p>${who} connections will appear here. Configure a flow and click <strong>Save</strong>.</p>
    </div>`;
    return;
  }

  countEl.textContent = `${conns.length} saved`;
  container.innerHTML = conns.map((c) => {
    const flow     = FLOWS.find((f) => f.id === c.flow);
    const orgLabel = c.orgType === 'custom'
      ? c.customUrl.replace(/^https?:\/\//, '')
      : c.orgType;
    return `
      <div class="saved-conn" data-id="${c.id}">
        <div class="saved-conn-info">
          <div class="saved-conn-name">${escapeHtml(c.name)}</div>
          <div class="saved-conn-meta">
            <span class="saved-conn-badge">${escapeHtml(flow ? flow.badge : c.flow)}</span>
            <span class="saved-conn-flow mono">${escapeHtml(flow ? flow.name : c.flow)}</span>
            <span class="saved-conn-org">· ${escapeHtml(orgLabel)}</span>
          </div>
        </div>
        <div class="saved-conn-actions">
          <button class="btn-ghost btn-sm" data-load="${c.id}">Load</button>
          <button class="btn-icon" data-delete="${c.id}" title="Delete">
            <svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.7">
              <path d="M2 2l10 10M12 2L2 12"/>
            </svg>
          </button>
        </div>
      </div>`;
  }).join('');

  $$('[data-load]',   container).forEach((btn) => {
    btn.addEventListener('click', () => {
      const conn = state.savedConnections.find((c) => c.id === btn.dataset.load);
      if (conn) loadConnection(conn);
    });
  });
  $$('[data-delete]', container).forEach((btn) => {
    btn.addEventListener('click', () => deleteConnection(btn.dataset.delete));
  });
}

function loadConnection(conn) {
  const radio = document.querySelector(`input[name="orgType"][value="${conn.orgType}"]`);
  if (radio) { radio.checked = true; radio.dispatchEvent(new Event('change')); }
  if (conn.orgType === 'custom' && conn.customUrl) {
    $('#customUrl').value = conn.customUrl;
    $('#customUrlWrap').classList.remove('hidden');
  }
  selectFlow(conn.flow);
  for (const [key, val] of Object.entries(conn.credentials || {})) {
    const el = document.querySelector(`[name="${key}"]`);
    if (el) el.value = val;
  }
  log('info', `Loaded <strong>${escapeHtml(conn.name)}</strong> — click Connect to authenticate`);
  toast(`Loaded: ${conn.name}`, 'ok');
}

function deleteConnection(id) {
  const conns = loadFromStorage().filter((c) => c.id !== id);
  persistToStorage(conns);
  const deleted = state.savedConnections.find((c) => c.id === id);
  renderSavedConnections();
  toast(`Deleted: ${deleted?.name || 'connection'}`, 'ok');
}

function toggleSaveDialog() {
  const dialog  = $('#saveDialog');
  const opening = dialog.classList.contains('hidden');
  dialog.classList.toggle('hidden', !opening);
  if (opening) setTimeout(() => $('#connName').focus(), 50);
}

function saveConnection() {
  const name = $('#connName').value.trim();
  if (!name) { toast('Enter a name for this connection.', 'err'); $('#connName').focus(); return; }

  const flow      = FLOWS.find((f) => f.id === state.selectedFlow);
  const credentials = collectFormValues(flow);
  const orgType   = $$('input[name="orgType"]').find((r) => r.checked)?.value || 'production';
  const customUrl = $('#customUrl').value.trim();

  const conns = loadFromStorage();
  const id    = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  conns.push({ id, name, orgType, customUrl, flow: flow.id, credentials, savedAt: new Date().toISOString() });
  persistToStorage(conns);

  $('#saveDialog').classList.add('hidden');
  $('#connName').value = '';
  renderSavedConnections();
  log('ok', `Connection <strong>${escapeHtml(name)}</strong> saved`);
  toast(`Saved: ${name}`, 'ok');
}

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

function resetAll() {
  state.tokens      = null;
  state.instanceUrl = null;
  if (state.devicePollHandle) clearInterval(state.devicePollHandle);
  state.devicePollHandle = null;
  $('#queryCard').hidden = true;
  $('#queryResult').innerHTML = '';
  $('#connState').textContent = 'Not connected';
  $('#connState').classList.remove('ok', 'err');
  $('#connBody').innerHTML = `<div class="empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/>
      </svg>
    </div>
    <p>Pick a flow and click <strong>Connect</strong>. Tokens and instance details appear here.</p>
  </div>`;
  $$('#credentialsForm input, #credentialsForm textarea').forEach((el) => (el.value = ''));
  toast('Reset', 'ok');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setBusy(busy) {
  const btn = $('#connectBtn');
  btn.disabled = busy;
  $('.btn-spin',  btn).hidden = !busy;
  $('.btn-label', btn).textContent = busy ? 'Connecting' : 'Connect';
}

function log(kind, msg) {
  const time = new Date().toTimeString().slice(0, 8);
  const li   = document.createElement('li');
  li.className = kind;
  li.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  $('#log').prepend(li);
}

function toast(msg, kind = '') {
  const stack = $('#toasts');
  const el    = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(() => {
    el.style.opacity    = '0';
    el.style.transition = 'opacity .25s';
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
