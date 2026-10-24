// DownStream email relay: a Google Apps Script web app that sends mail from your Gmail account.
//
// Why: Render's free plan blocks outbound SMTP ports (25, 465, 587) since September 2025, so the site can't
// reach smtp.gmail.com. It can make HTTPS requests, so it POSTs each email here and Gmail sends it.
//
// Setup (signed in as the Gmail account that should send the mail, e.g. gazebot.alert@gmail.com):
//   1. https://script.google.com > New project. Replace Code.gs with this file. Save.
//   2. Project Settings (gear) > Script Properties > Add: SECRET = a long random string.
//   3. Deploy > New deployment > type "Web app". Execute as: Me. Who has access: Anyone. Deploy.
//      Approve the "send email as you" permission when asked.
//   4. Copy the Web app URL (https://script.google.com/macros/s/.../exec). On Render, set
//      EMAIL_RELAY_URL to that URL and EMAIL_RELAY_SECRET to the same SECRET.
// After editing this script, Deploy > Manage deployments > edit > Version: New version, or the URL keeps
// serving the old code.
//
// Limits: a personal Gmail account can send to about 100 recipients a day through Apps Script.

function doPost(e) {
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('SECRET');
    var m = JSON.parse(e.postData.contents);
    if (!secret || m.secret !== secret) return reply({ ok: false, error: 'bad secret' });
    if (!m.to || !m.subject || !(m.html || m.text)) return reply({ ok: false, error: 'missing to, subject or body' });
    MailApp.sendEmail({
      to: m.to,
      subject: m.subject,
      body: m.text || '',
      htmlBody: m.html || undefined,
      name: m.name || 'DownStream',
    });
    return reply({ ok: true, id: Utilities.getUuid(), remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err && err.message || err) });
  }
}

// A GET from a browser shows whether the deployment is live and how much quota is left today.
function doGet() {
  return reply({ ok: true, service: 'DownStream email relay', remaining: MailApp.getRemainingDailyQuota() });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
