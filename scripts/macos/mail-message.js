function run(argv) {
  const payload = JSON.parse(argv[0]);
  const Mail = Application("Mail");
  const message = Mail.OutgoingMessage({
    subject: payload.subject,
    content: payload.body + "\n",
    visible: false
  });
  Mail.outgoingMessages.push(message);
  message.toRecipients.push(Mail.ToRecipient({ address: payload.to }));
  if (payload.send) message.send();
  else message.save();
  let id = null;
  try { id = message.id(); } catch (_) {}
  return JSON.stringify({ id: id, sent: Boolean(payload.send) });
}
