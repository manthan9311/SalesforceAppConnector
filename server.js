/**
 * Salesforce Connector - Backend
 *
 * Supports all standard Salesforce OAuth 2.0 flows for Connected Apps
 * and External Client Apps:
 *   - Username-Password (legacy)
 *   - Client Credentials
 *   - JWT Bearer (server-to-server)
 *   - Refresh Token
 *   - Web Server (Authorization Code) - with or without PKCE
 *   - User-Agent (Implicit) - PKCE-only on Salesforce since Spring '25
 *   - Device Authorization
 *
 * Auth: Optional Google sign-in. Set GOOGLE_CLIENT_ID and
 * GOOGLE_CLIENT_SECRET in a .env file to enable it.
 * Connections are stored in the browser's localStorage, namespaced
 * per user so no two users share the same saved connections.
 */

require('dotenv').config();

const express  = require('express');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const path     = require('path');
const session  = require('express-session');
const passport = require('passport');

const app  = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Body parsing + static files
// ---------------------------------------------------------------------------
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));
app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------------------------
// Google OAuth (only if credentials are configured in .env)
// ---------------------------------------------------------------------------
const GOOGLE_ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);

if (GOOGLE_ENABLED) {
  const { Strategy: GoogleStrategy } = require('passport-google-oauth20');

  passport.use(new GoogleStrategy(
    {
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  process.env.GOOGLE_CALLBACK_URL || `http://localhost:${PORT}/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      done(null, {
        id:     profile.id,
        name:   profile.displayName,
        email:  profile.emails?.[0]?.value  || '',
        avatar: profile.photos?.[0]?.value  || '',
      });
    }
  ));

  passport.serializeUser((user, done) => done(null, user));
  passport.deserializeUser((user, done) => done(null, user));

  app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
  );

  app.get('/auth/google/callback',
    passport.authenticate('google', { failureRedirect: '/?auth=failed' }),
    (req, res) => res.redirect('/?auth=success')
  );
}

/** Who am I? Used by the frontend on every load. */
app.get('/auth/me', (req, res) => {
  res.json({ user: req.user || null, googleEnabled: GOOGLE_ENABLED });
});

/** Sign out. */
app.post('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: err.message });
    req.session.destroy(() => res.json({ ok: true }));
  });
});

// ---------------------------------------------------------------------------
// In-memory session store for Salesforce OAuth state
// ---------------------------------------------------------------------------
const sessions = new Map();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of sessions) {
    if (v.createdAt < cutoff) sessions.delete(k);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getLoginUrl(orgType, customUrl) {
  if (orgType === 'sandbox') return 'https://test.salesforce.com';
  if (orgType === 'custom' && customUrl) {
    let u = customUrl.trim();
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/+$/, '');
  }
  return 'https://login.salesforce.com';
}

function genCodeVerifier() {
  return crypto.randomBytes(32).toString('base64url');
}

function genCodeChallenge(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function getCallbackUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host  = req.headers['x-forwarded-host']  || req.get('host');
  return `${proto}://${host}/api/callback`;
}

async function postForm(url, params) {
  const body = new URLSearchParams(params).toString();
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body,
  });
  const text = await resp.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: resp.ok, status: resp.status, data };
}

function tokenError(data, status) {
  return {
    error: data.error_description || data.error || data.message || `HTTP ${status}`,
    code:  data.error || null,
    raw:   data,
  };
}

// ---------------------------------------------------------------------------
// Flow: Username-Password
// ---------------------------------------------------------------------------
async function usernamePasswordFlow(loginUrl, p) {
  if (!p.clientId || !p.clientSecret || !p.username || !p.password) {
    return { error: 'clientId, clientSecret, username, and password are required.' };
  }
  const password = (p.password || '') + (p.securityToken || '');
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, {
    grant_type: 'password', client_id: p.clientId, client_secret: p.clientSecret,
    username: p.username, password,
  });
  return ok ? { tokens: data } : tokenError(data, status);
}

// ---------------------------------------------------------------------------
// Flow: Client Credentials
// ---------------------------------------------------------------------------
async function clientCredentialsFlow(loginUrl, p) {
  if (!p.clientId || !p.clientSecret) {
    return { error: 'clientId and clientSecret are required.' };
  }
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, {
    grant_type: 'client_credentials', client_id: p.clientId, client_secret: p.clientSecret,
  });
  return ok ? { tokens: data } : tokenError(data, status);
}

// ---------------------------------------------------------------------------
// Flow: JWT Bearer
// ---------------------------------------------------------------------------
async function jwtBearerFlow(loginUrl, p) {
  if (!p.clientId || !p.username || !p.privateKey) {
    return { error: 'clientId, username, and privateKey (PEM) are required.' };
  }
  const claims = {
    iss: p.clientId, sub: p.username, aud: loginUrl,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  let assertion;
  try { assertion = jwt.sign(claims, p.privateKey, { algorithm: 'RS256' }); }
  catch (e) { return { error: 'JWT signing failed: ' + e.message }; }
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion,
  });
  return ok ? { tokens: data } : tokenError(data, status);
}

// ---------------------------------------------------------------------------
// Flow: Refresh Token
// ---------------------------------------------------------------------------
async function refreshTokenFlow(loginUrl, p) {
  if (!p.clientId || !p.refreshToken) {
    return { error: 'clientId and refreshToken are required.' };
  }
  const params = { grant_type: 'refresh_token', client_id: p.clientId, refresh_token: p.refreshToken };
  if (p.clientSecret) params.client_secret = p.clientSecret;
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, params);
  return ok ? { tokens: data } : tokenError(data, status);
}

// ---------------------------------------------------------------------------
// Flow: Device Authorization (start / poll)
// ---------------------------------------------------------------------------
async function deviceFlowStart(loginUrl, p) {
  if (!p.clientId) return { error: 'clientId is required.' };
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, {
    response_type: 'device_code', client_id: p.clientId, scope: p.scope || 'api refresh_token',
  });
  return ok ? { deviceCode: data, loginUrl } : tokenError(data, status);
}

async function deviceFlowPoll(loginUrl, p) {
  if (!p.clientId || !p.deviceCode) {
    return { error: 'clientId and deviceCode are required.' };
  }
  const { ok, data, status } = await postForm(`${loginUrl}/services/oauth2/token`, {
    grant_type: 'device', client_id: p.clientId, code: p.deviceCode,
  });
  return ok
    ? { tokens: data }
    : { ...tokenError(data, status), pending: data.error === 'authorization_pending' };
}

// ---------------------------------------------------------------------------
// Flow: Web Server (Authorization Code)
// ---------------------------------------------------------------------------
function initWebServerFlow(loginUrl, p, req, { usePkce, useSecret }) {
  if (!p.clientId) return { error: 'clientId is required.' };
  if (useSecret && !p.clientSecret) return { error: 'clientSecret is required for this flow.' };
  const state       = crypto.randomBytes(16).toString('hex');
  const callbackUrl = getCallbackUrl(req);
  const sfSession   = {
    flow: 'web-server', loginUrl, clientId: p.clientId,
    clientSecret: useSecret ? p.clientSecret : undefined,
    callbackUrl, createdAt: Date.now(),
  };
  const authParams = new URLSearchParams({
    response_type: 'code', client_id: p.clientId,
    redirect_uri: callbackUrl, state, scope: p.scope || 'api refresh_token',
  });
  if (p.prompt) authParams.set('prompt', p.prompt);
  if (usePkce) {
    const verifier = genCodeVerifier();
    sfSession.codeVerifier = verifier;
    authParams.set('code_challenge', genCodeChallenge(verifier));
    authParams.set('code_challenge_method', 'S256');
  }
  sessions.set(state, sfSession);
  return { authUrl: `${loginUrl}/services/oauth2/authorize?${authParams}`, state, callbackUrl };
}

// ---------------------------------------------------------------------------
// Flow: User-Agent (Implicit)
// ---------------------------------------------------------------------------
function initUserAgentFlow(loginUrl, p, req) {
  if (!p.clientId) return { error: 'clientId is required.' };
  const state       = crypto.randomBytes(16).toString('hex');
  const callbackUrl = getCallbackUrl(req);
  const authParams  = new URLSearchParams({
    response_type: 'token', client_id: p.clientId,
    redirect_uri: callbackUrl, state, scope: p.scope || 'api refresh_token',
  });
  return { authUrl: `${loginUrl}/services/oauth2/authorize?${authParams}`, state, callbackUrl };
}

// ===========================================================================
// Routes
// ===========================================================================

app.get('/api/health', (req, res) => {
  res.json({ ok: true, callbackUrl: getCallbackUrl(req) });
});

app.post('/api/connect', async (req, res) => {
  const { flow, orgType, customUrl, ...params } = req.body;
  const loginUrl = getLoginUrl(orgType, customUrl);
  try {
    let result;
    switch (flow) {
      case 'username-password':  result = await usernamePasswordFlow(loginUrl, params);  break;
      case 'client-credentials': result = await clientCredentialsFlow(loginUrl, params); break;
      case 'jwt-bearer':         result = await jwtBearerFlow(loginUrl, params);         break;
      case 'refresh-token':      result = await refreshTokenFlow(loginUrl, params);      break;
      case 'device-start':       result = await deviceFlowStart(loginUrl, params);       break;
      case 'device-poll':        result = await deviceFlowPoll(loginUrl, params);        break;
      case 'web-server':
        result = initWebServerFlow(loginUrl, params, req, { usePkce: false, useSecret: true }); break;
      case 'web-server-pkce':
        result = initWebServerFlow(loginUrl, params, req, { usePkce: true, useSecret: !!params.clientSecret }); break;
      case 'user-agent':         result = initUserAgentFlow(loginUrl, params, req);      break;
      default: return res.status(400).json({ error: `Unknown flow: ${flow}` });
    }
    res.json({ loginUrl, ...result });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || String(err) });
  }
});

app.get('/api/callback', async (req, res) => {
  const { code, state, error, error_description } = req.query;
  if (error) return res.send(buildCallbackHtml({ error: error_description || error }));
  if (!code)  return res.send(buildImplicitCallbackHtml());

  const sfSession = sessions.get(state);
  if (!sfSession) {
    return res.send(buildCallbackHtml({ error: 'Unknown or expired state. Please retry the connection.' }));
  }
  const params = {
    grant_type: 'authorization_code', code,
    client_id: sfSession.clientId, redirect_uri: sfSession.callbackUrl,
  };
  if (sfSession.clientSecret)  params.client_secret  = sfSession.clientSecret;
  if (sfSession.codeVerifier)  params.code_verifier  = sfSession.codeVerifier;

  const { ok, data, status } = await postForm(`${sfSession.loginUrl}/services/oauth2/token`, params);
  sessions.delete(state);
  res.send(ok ? buildCallbackHtml({ tokens: data }) : buildCallbackHtml(tokenError(data, status)));
});

app.post('/api/query', async (req, res) => {
  const { instanceUrl, accessToken, query, apiVersion } = req.body;
  if (!instanceUrl || !accessToken || !query) {
    return res.status(400).json({ error: 'instanceUrl, accessToken, and query are required.' });
  }
  const version = apiVersion || 'v60.0';
  const url = `${instanceUrl.replace(/\/$/, '')}/services/data/${version}/query?q=${encodeURIComponent(query)}`;
  try {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' } });
    const text = await resp.text();
    let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!resp.ok) return res.status(resp.status).json({ error: data });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/userinfo', async (req, res) => {
  const { instanceUrl, accessToken } = req.body;
  if (!instanceUrl || !accessToken) {
    return res.status(400).json({ error: 'instanceUrl and accessToken are required.' });
  }
  try {
    const resp = await fetch(`${instanceUrl.replace(/\/$/, '')}/services/oauth2/userinfo`,
      { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: data });
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------------------------------------------------------------------------
// Inline callback pages
// ---------------------------------------------------------------------------

function buildCallbackHtml(result) {
  const safe    = JSON.stringify(result).replace(/</g, '\\u003c');
  const success = !result.error;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Salesforce Auth</title>
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { font-family: ui-sans-serif, system-ui, sans-serif;
    background: radial-gradient(circle at 30% 20%, #142036 0%, #060912 70%);
    color: #e2e8f0; display: grid; place-items: center; }
  .box { text-align: center; padding: 2.5rem 3rem;
    border: 1px solid #1f2a44; border-radius: 14px;
    background: rgba(15,22,38,0.7); backdrop-filter: blur(14px); max-width: 32rem; }
  .badge { display:inline-flex; align-items:center; gap:.5rem;
    padding:.35rem .8rem; border-radius:999px;
    font-family: ui-monospace,monospace; font-size:.75rem;
    letter-spacing:.08em; text-transform:uppercase;
    background: ${success ? 'rgba(16,185,129,.12)' : 'rgba(245,158,11,.12)'};
    color: ${success ? '#34d399' : '#fbbf24'};
    border: 1px solid ${success ? 'rgba(16,185,129,.3)' : 'rgba(245,158,11,.3)'}; }
  h1 { margin: 1rem 0 .5rem; font-size: 1.4rem; font-weight: 500; }
  p  { color: #94a3b8; margin: 0; font-size: .95rem; }
  .dot { width:6px; height:6px; border-radius:50%; background: currentColor; }
</style></head><body>
<div class="box">
  <span class="badge"><span class="dot"></span>${success ? 'Authenticated' : 'Auth Failed'}</span>
  <h1>${success ? 'Connection established' : 'Authentication failed'}</h1>
  <p>${success ? 'Sending credentials back to the app…' : escapeHtml(result.error || 'Unknown error')}</p>
</div>
<script>
  const result = ${safe};
  if (window.opener) {
    try { window.opener.postMessage({ type: 'sf-auth-result', result }, '*'); } catch (_) {}
    setTimeout(() => window.close(), result.error ? 4000 : 700);
  }
</script></body></html>`;
}

function buildImplicitCallbackHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Salesforce Auth</title>
<style>
  :root { color-scheme: dark; }
  html, body { height:100%; margin:0; }
  body { font-family:ui-sans-serif,system-ui,sans-serif;
    background:radial-gradient(circle at 30% 20%,#142036 0%,#060912 70%);
    color:#e2e8f0; display:grid; place-items:center; }
  .box { text-align:center; padding:2rem; }
  .spinner { width:32px; height:32px; border:2px solid #1f2a44;
    border-top-color:#22d3ee; border-radius:50%;
    animation:spin .9s linear infinite; margin:0 auto 1rem; }
  @keyframes spin { to { transform:rotate(360deg); } }
</style></head><body>
<div class="box"><div class="spinner"></div><p>Finishing sign-in…</p></div>
<script>
  const frag = window.location.hash.replace(/^#/,'');
  const params = new URLSearchParams(frag);
  const obj = {};
  for (const [k,v] of params) obj[k]=v;
  const result = obj.error ? {error:obj.error_description||obj.error} : {tokens:obj};
  if (window.opener) {
    try { window.opener.postMessage({type:'sf-auth-result',result},'*'); } catch(_){}
  }
  setTimeout(()=>window.close(),500);
</script></body></html>`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log('');
  console.log('  Salesforce Connector  v1.1');
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log(`  OAuth callback: http://localhost:${PORT}/api/callback`);
  console.log(`  Google auth:    ${GOOGLE_ENABLED ? 'enabled' : 'disabled (set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET in .env to enable)'}`);
  console.log('');
});
