# Salesforce Connector 1.0

A local Node.js + browser app that lets you connect to **any Salesforce org**
using **any of the supported OAuth 2.0 flows** for both **Connected Apps**
and the newer **External Client Apps**. After connecting, run a SOQL query
against the `Account` object to verify the session.

## What's supported

| Flow | Use case | Interactive? |
|---|---|---|
| **Web Server (auth code)** | Trusted backend apps with a client secret | Yes |
| **Web Server + PKCE** | SPAs, mobile, public clients | Yes |
| **User-Agent (Implicit)** | Legacy SPAs (deprecated) | Yes |
| **JWT Bearer** | Server-to-server, no user prompt | No |
| **Client Credentials** | Pure machine-to-machine (needs Run-As user) | No |
| **Username-Password** | Quick scripts / legacy automation (deprecated) | No |
| **Device Authorization** | TVs, CLIs, IoT, anything without a browser | Yes (on a separate device) |
| **Refresh Token** | Renew a session without re-prompting | No |

All flows work against **production**, **sandbox** (`test.salesforce.com`),
and **custom My-Domain** endpoints.

---

## Prerequisites

- **Node.js 18 or newer** (uses native `fetch` and `--watch`)
- A Salesforce org and either a **Connected App** or an **External Client App**

## Install & run

```bash
npm install
npm start
```

Open <http://localhost:3000>.

The console will print the OAuth callback URL — typically
`http://localhost:3000/api/callback`. Add this URL to your Connected App or
External Client App's callback URL list before running any interactive flow.

---

## Setting up a Connected App in Salesforce

1. **Setup → App Manager → New Connected App** (or **External Client App**).
2. Fill in basic info (name, contact email).
3. Check **Enable OAuth Settings**.
4. **Callback URL:** add `http://localhost:3000/api/callback`.
5. **Selected OAuth Scopes:** at minimum:
   - `Manage user data via APIs (api)`
   - `Perform requests at any time (refresh_token, offline_access)`
6. Depending on which flows you'll use:
   - **JWT Bearer** — check **Use digital signatures** and upload your X.509
     certificate (`.crt` file matching your private key).
   - **Client Credentials** — check **Enable Client Credentials Flow** and
     pick a **Run As** user in OAuth Policies (after creation).
   - **Device Flow** — check **Enable Device Flow**.
   - **PKCE / Implicit** — check **Require Proof Key for Code Exchange**
     for SPAs.
7. Save. **Wait ~10 minutes** for the app to propagate before testing.
8. From the Connected App detail page, copy the **Consumer Key** (Client ID)
   and **Consumer Secret** (Client Secret).

### For JWT — generating a key pair

```bash
# Private key (keep secret, paste into the app)
openssl genrsa -out server.key 2048

# Public certificate (upload to the Connected App)
openssl req -new -x509 -key server.key -out server.crt -days 3650 \
  -subj "/CN=salesforce-jwt"
```

Then in Salesforce:
- Connected App → Edit → check **Use digital signatures** → upload `server.crt`.
- For the user named in the JWT `sub` claim, pre-authorize the Connected App:
  Setup → **Manage Connected Apps** → your app → **Manage Profiles** or
  **Manage Permission Sets**, and add the relevant profile/permission set.

Paste the contents of `server.key` (PEM, including the `-----BEGIN/END-----`
lines) into the **Private Key** field in the UI.

### For Client Credentials — setting a Run-As user

After saving the Connected App:
1. Go to **Manage Connected Apps** → your app → **Edit Policies**.
2. Scroll to **Client Credentials Flow** → set **Run As** to an integration
   user (must have API Enabled permission).
3. Save.

---

## How each flow uses the app

### 1. Web Server (authorization code)
1. Pick the org type.
2. Choose **Web Server**.
3. Enter Client ID + Client Secret.
4. Click **Connect** → a popup opens the Salesforce login.
5. After login + consent, the popup self-closes and tokens appear in the
   right column.

### 2. Web Server + PKCE
Same as above. Client Secret is **optional** — leave it blank if your
Connected App is configured as a public client. The app generates an S256
code verifier/challenge automatically.

### 3. User-Agent (Implicit)
Same flow as Web Server but `response_type=token`. The access token is
returned in the URL fragment and parsed client-side. **Salesforce
discourages this flow** — prefer PKCE.

### 4. JWT Bearer
1. Pick the org type. (For sandboxes the JWT `aud` is auto-set to
   `https://test.salesforce.com`.)
2. Choose **JWT Bearer**.
3. Enter Client ID, the pre-authorized **username**, and paste the **PEM
   private key**.
4. Click **Connect**. No browser popup — tokens come back immediately.

### 5. Client Credentials
1. Pick the org type.
2. Choose **Client Credentials**.
3. Enter Client ID + Client Secret.
4. Click **Connect**. The token belongs to the Run-As user.

### 6. Username-Password
1. Choose **Username-Password**.
2. Enter Client ID, Client Secret, username, password, and (if your IP
   isn't whitelisted) your **Security Token**.
3. Click **Connect**.

### 7. Device Flow
1. Choose **Device Flow**.
2. Enter just the Client ID.
3. Click **Connect**. The app shows a user code and a verification URL.
4. Visit that URL on **any device**, enter the code, and approve.
5. This app polls in the background until the token arrives, then shows it.

### 8. Refresh Token
1. Choose **Refresh Token**.
2. Enter Client ID, Client Secret (optional for public clients), and a
   previously obtained refresh token.
3. Click **Connect**.

---

## Verifying the connection

Once tokens are returned, the **Verify with SOQL** card appears. It comes
pre-loaded with:

```sql
SELECT Id, Name, Industry FROM Account ORDER BY CreatedDate DESC LIMIT 5
```

Click **Run query** to hit
`/services/data/v60.0/query` on the returned `instance_url`. Results render
as a table. Click **Get user info** for a quick `/services/oauth2/userinfo`
identity check.

---

## Project layout

```
salesforce-connector/
├── package.json
├── server.js                # Express server + all OAuth flows
├── public/
│   ├── index.html           # UI shell
│   ├── styles.css           # Dark technical theme
│   └── app.js               # Frontend logic
└── README.md
```

## API surface (for reference)

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/connect` | Dispatches the chosen flow |
| `GET` | `/api/callback` | OAuth redirect target |
| `POST` | `/api/query` | Execute SOQL using a previously issued token |
| `POST` | `/api/userinfo` | Hit `/services/oauth2/userinfo` |
| `GET` | `/api/health` | Liveness + callback URL |

---

## Security notes

- This is a **local developer tool**. Tokens are held in browser memory and
  sent to your local Express process only.
- The in-memory session store on the server holds OAuth state for ~10
  minutes; sessions never touch disk.
- Don't expose this app to the public internet without adding a session
  store, CSRF protection, and TLS.
- If you change the port (`PORT=4000 npm start`), update the callback URL
  on the Connected App to match.

## Troubleshooting

**`invalid_client_id`** — Wait ~10 minutes after creating the Connected
App. Verify the Consumer Key matches.

**`invalid_grant: user hasn't approved this consumer`** — For JWT Bearer,
pre-authorize the user via a profile or permission set on the Connected
App's **Manage** page.

**`redirect_uri_mismatch`** — The callback URL printed at startup must
appear *exactly* in the Connected App's Callback URL list (trailing slashes
matter).

**`unsupported_grant_type`** — The org or app doesn't have that flow
enabled. Check the Connected App's OAuth Policies and (for Client
Credentials / Device) ensure the relevant checkbox is on.

**Popup blocked** — Allow popups for `localhost:3000`.

## License

MIT
