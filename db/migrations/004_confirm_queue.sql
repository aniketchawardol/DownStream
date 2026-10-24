-- Confirmation emails can be queued: Render's free web services can't open SMTP connections, so in
-- production the site saves the subscription and the scheduled mailer (GitHub Actions) sends the email.
alter table subscription add column confirm_sent_at timestamptz;
-- Rows created before this migration were confirmed inline, or never will be: don't send them again.
update subscription set confirm_sent_at = created_at;
create index subscription_confirm_queue_idx on subscription (created_at)
  where confirmed_at is null and confirm_sent_at is null and unsubscribed_at is null;
