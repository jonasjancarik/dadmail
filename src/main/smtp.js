import nodemailer from 'nodemailer';

export async function sendEmail(db, { to, subject, text, replyToId }) {
  // Get credentials from settings
  const settingsStmt = db.prepare('SELECT key, value FROM settings');
  const settingsRows = settingsStmt.all();
  const settings = {};
  settingsRows.forEach(row => {
    settings[row.key] = row.value;
  });
  
  if (!settings.email || !settings.password) {
    throw new Error('Email credentials not configured');
  }
  
  // Create transporter
  const transporter = nodemailer.createTransport({
    host: 'smtp.seznam.cz',
    port: 465,
    secure: true,
    auth: {
      user: settings.email,
      pass: settings.password,
    },
  });
  
  // If replying, get the original email for threading
  let inReplyTo = null;
  let references = null;
  
  if (replyToId) {
    const emailStmt = db.prepare('SELECT message_id, subject FROM emails WHERE id = ?');
    const originalEmail = emailStmt.get(replyToId);
    
    if (originalEmail) {
      inReplyTo = originalEmail.message_id;
      references = originalEmail.message_id;
      
      // Ensure subject starts with Re: if it doesn't already
      if (!subject.startsWith('Re:') && !subject.startsWith('RE:')) {
        subject = `Re: ${subject}`;
      }
    }
  }
  
  // Send email
  const mailOptions = {
    from: settings.email,
    to: to,
    subject: subject,
    text: text,
    inReplyTo: inReplyTo,
    references: references,
  };
  
  await transporter.sendMail(mailOptions);
}


