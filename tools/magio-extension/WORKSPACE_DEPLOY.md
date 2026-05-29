# Force-installing the Wildflower CRM extension via Google Workspace

Audience: Wildflower Workspace admin. ~10 CRM users.

## Prerequisites

1. A Google Workspace admin account (admin.google.com).
2. The extension published as **Unlisted** to the Chrome Web Store (see STORE_LISTING.md). You'll need:
   - The **extension ID** from the store URL: `chrome.google.com/webstore/detail/<name>/<EXTENSION_ID>` — the ID is the 32-character lowercase string at the end.
3. A group or organizational unit containing the ~10 CRM users you want to receive the extension. A **Google Group** is easier than an OU because users can be added/removed without moving them in the directory. Suggested name: `wildflower-crm-users@wildflowerschools.org`.

## Steps

1. Sign in to **admin.google.com**.
2. Navigate to **Devices → Chrome → Apps & extensions → Users & browsers**.
3. At the top of the page, use the org-unit / group selector on the left to pick `wildflower-crm-users` (or whichever group you created). If you don't see groups in the selector, click **Groups** in the left tree and add the group to the policy scope first.
4. Click the **+** (yellow plus) button in the bottom right → **Add Chrome app or extension by ID**.
5. Paste the extension ID. Leave the "From the Chrome Web Store" radio selected. Click **Save**.
6. The extension now appears in the policy list. Click it to open the right-side detail panel.
7. Under **Installation policy**, choose **Force install** (or **Force install + pin to browser toolbar** if you want the popup icon always visible). Click **Save** at the top.

That's it. Within 90 minutes (or immediately on the user's next Chrome restart) the extension auto-installs on Chrome profiles signed in with one of the targeted Workspace accounts. Users can't disable or uninstall it, and it will auto-update when you publish a new version to the Web Store.

## Adding or removing users later

Just add or remove the user from the `wildflower-crm-users` group in admin.google.com → Directory → Groups. The extension will be installed or uninstalled on their next Chrome restart.

## Publishing updates

1. Bump the `version` field in `tools/magio-extension/package.json`.
2. Build **against the production CRM domain** and package the zip:
   ```bash
   cd tools/magio-extension
   PLASMO_PUBLIC_API_URL=https://wfcrm.replit.app pnpm build
   PLASMO_PUBLIC_API_URL=https://wfcrm.replit.app pnpm package
   # zip lands at build/chrome-mv3-prod.zip (rename as desired)
   ```
   Skipping `PLASMO_PUBLIC_API_URL` makes the build fall back to `http://localhost:3000`, which breaks all tracking on recipients' machines.
3. Upload the new zip to the Chrome Web Store developer dashboard for this item.
4. Submit for review. Once approved (usually <24h for an update to an existing unlisted item), Chrome will auto-update for all 10 users within ~24h, no admin action required.

The current uploadable build is **v1.0.1**, pointed at `https://wfcrm.replit.app`, at `tools/magio-extension/build/wildflower-tracking-extension.zip`.

## Troubleshooting

- **Extension didn't appear on a user's Chrome.** Have them visit `chrome://policy` and search for `ExtensionInstallForcelist` — the ID should be listed. If not, the policy hasn't synced; have them sign out of Chrome and back in.
- **"Item not found" error in the admin console when adding by ID.** The Web Store listing is probably still in "Pending review". Wait for it to be approved before adding it to the force-install list.
- **User on a personal Google account instead of Workspace.** Force-install only applies to Workspace-managed accounts. Personal accounts have to side-load manually.
