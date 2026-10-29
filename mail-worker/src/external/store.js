// All rows and attachment references become visible in one D1 transaction.
// Provider ID + delivered recipient is the deduplication key, including concurrent retries.
export async function storeReceived(db, providerId, row, attachments) {
  const columns = ['resend_email_id','send_email','name','account_id','user_id','subject','code','text','content',
    'cc','bcc','recipient','to_email','to_name','in_reply_to','relation','message_id','type','status','is_del'];
  const values = [providerId,row.sendEmail,row.name,row.accountId,row.userId,row.subject || '',row.code || '',
    row.text || '',row.content || '',JSON.stringify(row.cc || []),'[]',JSON.stringify(row.recipients || []),
    row.toEmail,row.toName || '',row.inReplyTo || '',row.references || '',row.messageId || '',0,row.status,0];
  const statements = [db.prepare(`INSERT OR IGNORE INTO email (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`).bind(...values)];
  for (const item of attachments) {
    statements.push(db.prepare(`INSERT INTO attachments
      (user_id,email_id,account_id,key,filename,mime_type,size,type,content_id,disposition,related,encoding)
      SELECT ?,e.email_id,?,?,?,?,?,?,?,?,?,? FROM email e
      WHERE e.resend_email_id=? AND e.to_email=? AND e.type=0 AND NOT EXISTS
      (SELECT 1 FROM attachments a WHERE a.email_id=e.email_id AND a.key=? AND COALESCE(a.content_id,'')=?)`)
      .bind(row.userId,row.accountId,item.key,item.filename || 'attachment',item.mimeType || 'application/octet-stream',
        item.size,0,item.contentId || null,item.disposition || null,item.related || null,item.encoding || null,
        providerId,row.toEmail,item.key,item.contentId || ''));
  }
  const results = await db.batch(statements);
  if (results.some(result => result.success === false)) throw new Error('Inbox transaction failed');
  const saved = await db.prepare('SELECT * FROM email WHERE resend_email_id=? AND to_email=? AND type=0').bind(providerId,row.toEmail).first();
  if (!saved) throw new Error('Inbox transaction did not save the message');
  return { inserted: results[0].meta.changes === 1, row: saved };
}
