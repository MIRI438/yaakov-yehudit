// Sends the bot's replies from the bot's own Gmail account, over HTTPS.
// Needed on hosts that block SMTP ports (Railway Free/Trial/Hobby).
//
// Setup (in the bot's Gmail account):
//   1. https://script.google.com → New project → paste this file → set SECRET below.
//   2. Deploy → New deployment → type "Web app" → Execute as: Me, Who has access: Anyone → Deploy.
//      Approve the permissions (Advanced → Go to project → Allow).
//   3. Copy the Web app URL into the bot's SEND_SCRIPT_URL, and SECRET into SEND_SCRIPT_SECRET.
// After editing this code, use Deploy → Manage deployments → Edit → Version: New version.

const SECRET = 'CHANGE-ME';

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET === 'CHANGE-ME' || req.secret !== SECRET) return reply_({ ok: false, error: 'bad secret' });

    if (req.action === 'ping') return reply_({ ok: true, email: Session.getEffectiveUser().getEmail() });

    if (req.action === 'send') {
      const attachments = (req.attachments || []).map(function (a) {
        return Utilities.newBlob(Utilities.base64Decode(a.content), a.contentType, a.filename);
      });
      const options = { attachments: attachments };

      // Reply inside the sender's original thread when we can find their message.
      const original = req.inReplyTo ? findMessage_(req.inReplyTo) : null;
      if (original) {
        original.reply(req.text, options);
      } else {
        GmailApp.sendEmail(req.to, req.subject, req.text, options);
      }
      return reply_({ ok: true });
    }
    return reply_({ ok: false, error: 'unknown action' });
  } catch (err) {
    return reply_({ ok: false, error: String(err && err.message || err) });
  }
}

function findMessage_(messageId) {
  const id = messageId.replace(/^<|>$/g, '');
  const threads = GmailApp.search('rfc822msgid:' + id);
  for (let i = 0; i < threads.length; i++) {
    const messages = threads[i].getMessages();
    for (let j = 0; j < messages.length; j++) {
      if (messages[j].getHeader('Message-ID').replace(/^<|>$/g, '') === id) return messages[j];
    }
  }
  return null;
}

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
