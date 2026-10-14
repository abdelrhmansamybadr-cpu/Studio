# Studio WhatsApp Marketing

Client targets sheet + WhatsApp QR login + automatic sending.

## Run (on your own computer, needs Node 18+)
```
npm install
npm start
```
Open http://localhost:3000, then:
1. **Scan the QR** with WhatsApp on your phone (Settings → Linked devices → Link a device). The session is remembered.
2. **Add clients**: paste a Google Sheet link (shared "Anyone with the link can view") or paste `name, phone` rows.
3. Edit the **message** (`{name}` is replaced per client) and press **Start sending**.

The Targets panel shows every client with name, phone and status (pending / sent / failed), plus total target, sent, pending, failed and a progress bar.

## Safety
Messages go out one at a time with a random delay (default 20–45 s) and a daily limit (default 100). Sending many messages to people who have not messaged you first can get a WhatsApp number banned — start small, and only message clients who expect to hear from you. Numbers not on WhatsApp are marked failed.

Set `CHROME_PATH` if Puppeteer cannot find a browser.
