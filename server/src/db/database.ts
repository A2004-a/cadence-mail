import { DatabaseSync } from 'node:sqlite';
import { config } from '../config.js';

let sharedDb: DatabaseSync | null = null;

export function createDatabase(dbPath: string = config.dbPath): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');
  initSchema(db);
  return db;
}

export function getDb(): DatabaseSync {
  if (!sharedDb) {
    sharedDb = createDatabase(config.dbPath);
  }
  return sharedDb;
}

export function closeDb(): void {
  if (sharedDb) {
    sharedDb.close();
    sharedDb = null;
  }
}

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin', 'member')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended')),
      quota_mb INTEGER NOT NULL DEFAULT 1024,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS domains (
      id TEXT PRIMARY KEY,
      domain TEXT NOT NULL UNIQUE COLLATE NOCASE,
      status TEXT NOT NULL DEFAULT 'pending_verification' CHECK(status IN ('pending_verification', 'active', 'disabled')),
      ownership_verified INTEGER NOT NULL DEFAULT 0,
      internal_only INTEGER NOT NULL DEFAULT 0,
      verification_token TEXT NOT NULL,
      dkim_selector TEXT NOT NULL DEFAULT 'cadence',
      dkim_public_key TEXT NOT NULL DEFAULT '',
      dkim_private_key_enc TEXT NOT NULL DEFAULT '',
      primary_mx_host TEXT NOT NULL DEFAULT '',
      spf_expected TEXT NOT NULL DEFAULT '',
      dmarc_expected TEXT NOT NULL DEFAULT '',
      verified_at TEXT,
      last_dns_check_at TEXT,
      last_dns_report_json TEXT NOT NULL DEFAULT '{}',
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_domains_status ON domains(status);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      csrf_token TEXT NOT NULL,
      user_agent TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_active_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS oauth_states (
      state TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL,
      code_verifier TEXT NOT NULL,
      redirect_after TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      preferences_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider_type TEXT NOT NULL CHECK(provider_type IN ('hosted', 'local', 'gmail', 'outlook', 'yahoo', 'imap_smtp')),
      account_ownership TEXT NOT NULL DEFAULT 'external' CHECK(account_ownership IN ('hosted', 'external')),
      domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
      email_address TEXT NOT NULL COLLATE NOCASE,
      display_name TEXT NOT NULL,
      avatar_color TEXT NOT NULL DEFAULT '#1D4ED8',
      signature_html TEXT NOT NULL DEFAULT '',
      signature_enabled INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'syncing', 'error', 'auth_expired', 'disconnected', 'suspended')),
      is_default INTEGER NOT NULL DEFAULT 0,
      quota_mb INTEGER NOT NULL DEFAULT 1024,
      used_bytes INTEGER NOT NULL DEFAULT 0,
      capabilities_json TEXT NOT NULL,
      encrypted_credentials TEXT NOT NULL DEFAULT '',
      sync_cursor TEXT NOT NULL DEFAULT '',
      last_synced_at TEXT,
      last_error TEXT,
      notification_prefs_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, email_address)
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);

    CREATE TABLE IF NOT EXISTS mailbox_aliases (
      id TEXT PRIMARY KEY,
      domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      alias_address TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_aliases_account ON mailbox_aliases(account_id);

    CREATE TABLE IF NOT EXISTS folders (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      remote_id TEXT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      system_role TEXT NOT NULL DEFAULT 'custom' CHECK(system_role IN ('inbox', 'priority', 'starred', 'important', 'sent', 'drafts', 'snoozed', 'archive', 'all', 'spam', 'trash', 'custom')),
      parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      color TEXT NOT NULL DEFAULT '#64748B',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(account_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_folders_user_account ON folders(user_id, account_id);

    CREATE TABLE IF NOT EXISTS labels (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      remote_id TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2563EB',
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_labels_user ON labels(user_id);

    CREATE TABLE IF NOT EXISTS categories (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#2563EB',
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      remote_thread_id TEXT,
      subject TEXT NOT NULL DEFAULT '(no subject)',
      snippet TEXT NOT NULL DEFAULT '',
      last_message_at TEXT NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      is_pinned INTEGER NOT NULL DEFAULT 0,
      in_inbox INTEGER NOT NULL DEFAULT 1,
      in_sent INTEGER NOT NULL DEFAULT 0,
      in_archive INTEGER NOT NULL DEFAULT 0,
      in_spam INTEGER NOT NULL DEFAULT 0,
      in_trash INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      category_slug TEXT NOT NULL DEFAULT 'primary',
      priority_score REAL NOT NULL DEFAULT 0.5,
      participants_json TEXT NOT NULL DEFAULT '[]',
      snoozed_until TEXT,
      snooze_restore_folder_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_user_last ON threads(user_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_account_last ON threads(account_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_inbox ON threads(user_id, in_inbox, in_trash, in_spam, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_snoozed ON threads(snoozed_until) WHERE snoozed_until IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_threads_remote ON threads(account_id, remote_thread_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      remote_id TEXT,
      message_id_header TEXT NOT NULL DEFAULT '',
      in_reply_to TEXT NOT NULL DEFAULT '',
      references_header TEXT NOT NULL DEFAULT '',
      folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
      from_name TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL COLLATE NOCASE,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      reply_to_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '(no subject)',
      body_html_sanitized TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      snippet TEXT NOT NULL DEFAULT '',
      has_external_images INTEGER NOT NULL DEFAULT 0,
      suspicious_links_json TEXT NOT NULL DEFAULT '[]',
      auth_results_json TEXT NOT NULL DEFAULT '{}',
      sent_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      is_draft INTEGER NOT NULL DEFAULT 0,
      is_spam INTEGER NOT NULL DEFAULT 0,
      is_trash INTEGER NOT NULL DEFAULT 0,
      is_archived INTEGER NOT NULL DEFAULT 0,
      has_attachments INTEGER NOT NULL DEFAULT 0,
      category_slug TEXT NOT NULL DEFAULT 'primary',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      raw_headers_json TEXT NOT NULL DEFAULT '{}',
      sync_status TEXT NOT NULL DEFAULT 'synced' CHECK(sync_status IN ('synced', 'pending', 'failed')),
      delivery_status TEXT NOT NULL DEFAULT 'synced' CHECK(delivery_status IN ('draft', 'queued', 'accepted_local', 'accepted_by_mx', 'retry_pending', 'bounced', 'failed', 'synced', 'received')),
      delivery_detail TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at ASC);
    CREATE INDEX IF NOT EXISTS idx_messages_account_remote ON messages(account_id, remote_id);
    CREATE INDEX IF NOT EXISTS idx_messages_msgid ON messages(account_id, message_id_header);
    CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages(folder_id);

    CREATE TABLE IF NOT EXISTS message_labels (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      label_id TEXT NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
      PRIMARY KEY (message_id, label_id)
    );
    CREATE INDEX IF NOT EXISTS idx_msg_labels_label ON message_labels(label_id);

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      draft_id TEXT,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      content_id TEXT NOT NULL DEFAULT '',
      is_inline INTEGER NOT NULL DEFAULT 0,
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_draft ON attachments(draft_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      user_id UNINDEXED,
      subject,
      body_text,
      from_name,
      from_address,
      recipients_text,
      attachment_names,
      tokenize='unicode61'
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      reply_to_message_id TEXT,
      mode TEXT NOT NULL DEFAULT 'new' CHECK(mode IN ('new', 'reply', 'reply_all', 'forward')),
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      is_plain_text INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'queued_undo', 'sending', 'scheduled', 'sent', 'failed')),
      scheduled_for TEXT,
      scheduled_timezone TEXT NOT NULL DEFAULT 'UTC',
      undo_send_until TEXT,
      last_error TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_drafts_user_status ON drafts(user_id, status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_drafts_undo ON drafts(status, undo_send_until) WHERE status = 'queued_undo';
    CREATE INDEX IF NOT EXISTS idx_drafts_sched ON drafts(status, scheduled_for) WHERE status = 'scheduled';

    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      remote_id TEXT,
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'provider_synced')),
      name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL COLLATE NOCASE,
      organization TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      avatar_color TEXT NOT NULL DEFAULT '#2563EB',
      is_favorite INTEGER NOT NULL DEFAULT 0,
      contact_count INTEGER NOT NULL DEFAULT 0,
      last_contacted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_contacts_user ON contacts(user_id, name);

    CREATE TABLE IF NOT EXISTS contact_groups (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#4F46E5',
      created_at TEXT NOT NULL,
      UNIQUE(user_id, name)
    );

    CREATE TABLE IF NOT EXISTS contact_group_members (
      group_id TEXT NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      PRIMARY KEY (group_id, contact_id)
    );

    CREATE TABLE IF NOT EXISTS rules (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      priority_order INTEGER NOT NULL DEFAULT 0,
      match_mode TEXT NOT NULL DEFAULT 'all' CHECK(match_mode IN ('all', 'any')),
      conditions_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL DEFAULT '[]',
      stop_processing INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rules_user ON rules(user_id, priority_order);

    CREATE TABLE IF NOT EXISTS templates (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT 'General',
      shortcut_key TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_templates_user ON templates(user_id);

    CREATE TABLE IF NOT EXISTS reminders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'dismissed', 'completed')),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id, status, due_at);

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read, created_at DESC);

    CREATE TABLE IF NOT EXISTS blocked_senders (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      email_or_domain TEXT NOT NULL COLLATE NOCASE,
      created_at TEXT NOT NULL,
      UNIQUE(user_id, email_or_domain)
    );

    CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_search_history_user ON search_history(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      messages_added INTEGER NOT NULL DEFAULT 0,
      messages_updated INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      error_message TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sync_logs_account ON sync_logs(account_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mail_queue (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      draft_id TEXT,
      message_id TEXT,
      from_address TEXT NOT NULL COLLATE NOCASE,
      recipients_json TEXT NOT NULL,
      subject TEXT NOT NULL DEFAULT '',
      raw_mime_path TEXT NOT NULL DEFAULT '',
      message_id_header TEXT NOT NULL DEFAULT '',
      delivery_mode TEXT NOT NULL DEFAULT 'hosted_mx' CHECK(delivery_mode IN ('hosted_mx', 'smtp_relay', 'internal', 'provider_api')),
      status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'accepted_local', 'accepted_by_mx', 'retry_pending', 'bounced', 'failed', 'dead_letter')),
      idempotency_key TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0,
      max_attempts INTEGER NOT NULL DEFAULT 5,
      next_attempt_at TEXT NOT NULL,
      remote_mx_host TEXT NOT NULL DEFAULT '',
      smtp_response TEXT NOT NULL DEFAULT '',
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mail_queue_due ON mail_queue(status, next_attempt_at);
    CREATE INDEX IF NOT EXISTS idx_mail_queue_user ON mail_queue(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS mail_delivery_logs (
      id TEXT PRIMARY KEY,
      queue_id TEXT,
      direction TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      domain TEXT NOT NULL DEFAULT '',
      from_address TEXT NOT NULL DEFAULT '',
      to_addresses_json TEXT NOT NULL DEFAULT '[]',
      message_id_header TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      remote_ip TEXT NOT NULL DEFAULT '',
      mx_host TEXT NOT NULL DEFAULT '',
      smtp_code INTEGER,
      smtp_message TEXT NOT NULL DEFAULT '',
      dkim_signed INTEGER NOT NULL DEFAULT 0,
      spf_result TEXT NOT NULL DEFAULT '',
      dkim_result TEXT NOT NULL DEFAULT '',
      dmarc_result TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delivery_logs_dir ON mail_delivery_logs(direction, created_at DESC);

    CREATE TABLE IF NOT EXISTS security_events (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info' CHECK(severity IN ('info', 'warning', 'high')),
      actor_email TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sec_events_time ON security_events(created_at DESC);

    CREATE TABLE IF NOT EXISTS backup_records (
      id TEXT PRIMARY KEY,
      created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      backup_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      include_attachments INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'completed',
      checksum_sha256 TEXT NOT NULL DEFAULT '',
      manifest_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS saved_searches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      query TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_saved_searches_user ON saved_searches(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS account_signatures (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body_html TEXT NOT NULL DEFAULT '',
      body_text TEXT NOT NULL DEFAULT '',
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_account_signatures_acct ON account_signatures(account_id, is_default DESC);

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo' CHECK(status IN ('todo', 'in_progress', 'completed')),
      priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low', 'medium', 'high', 'urgent')),
      category TEXT NOT NULL DEFAULT 'General',
      due_at TEXT,
      reminder_at TEXT,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      contact_id TEXT REFERENCES contacts(id) ON DELETE SET NULL,
      attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
      assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON tasks(user_id, status, due_at);

    CREATE TABLE IF NOT EXISTS calendar_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      meeting_url TEXT NOT NULL DEFAULT '',
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      all_day INTEGER NOT NULL DEFAULT 0,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'confirmed' CHECK(status IN ('confirmed', 'tentative', 'cancelled')),
      attendees_json TEXT NOT NULL DEFAULT '[]',
      reminder_minutes INTEGER NOT NULL DEFAULT 15,
      source TEXT NOT NULL DEFAULT 'local' CHECK(source IN ('local', 'extracted', 'ics', 'google', 'outlook')),
      external_event_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cal_user_start ON calendar_events(user_id, start_at ASC);

    CREATE TABLE IF NOT EXISTS rule_execution_logs (
      id TEXT PRIMARY KEY,
      rule_id TEXT NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK(status IN ('executed', 'skipped_guard', 'failed')),
      detail TEXT NOT NULL DEFAULT '',
      executed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_rule_logs_user ON rule_execution_logs(user_id, executed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_rule_logs_dedup ON rule_execution_logs(rule_id, message_id);

    CREATE TABLE IF NOT EXISTS ai_workflow_runs (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL,
      workflow_type TEXT NOT NULL,
      prompt TEXT NOT NULL,
      plan_json TEXT NOT NULL DEFAULT '[]',
      actions_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'awaiting_confirmation' CHECK(status IN ('planned', 'awaiting_confirmation', 'executed', 'cancelled', 'failed')),
      error TEXT,
      created_at TEXT NOT NULL,
      completed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_workflows_user ON ai_workflow_runs(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS shared_mailboxes (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id)
    );

    CREATE TABLE IF NOT EXISTS shared_mailbox_members (
      mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'agent' CHECK(role IN ('owner', 'admin', 'agent', 'viewer')),
      added_at TEXT NOT NULL,
      PRIMARY KEY (mailbox_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_shared_members_user ON shared_mailbox_members(user_id);

    CREATE TABLE IF NOT EXISTS thread_assignments (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
      assigned_to_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      assigned_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'pending', 'resolved')),
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS thread_notes (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      mailbox_id TEXT NOT NULL REFERENCES shared_mailboxes(id) ON DELETE CASCADE,
      author_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author_name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_thread_notes_thread ON thread_notes(thread_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS automation_assets (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '',
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auto_assets_user ON automation_assets(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS automation_info_profiles (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'custom' CHECK(kind IN ('location', 'contact', 'document', 'custom')),
      title TEXT NOT NULL,
      content_text TEXT NOT NULL DEFAULT '',
      map_query TEXT NOT NULL DEFAULT '',
      map_url TEXT NOT NULL DEFAULT '',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(user_id, slug)
    );
    CREATE INDEX IF NOT EXISTS idx_auto_info_user ON automation_info_profiles(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_automations (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      frequency TEXT NOT NULL DEFAULT 'daily' CHECK(frequency IN ('daily', 'weekdays', 'weekly', 'monthly', 'interval_hours')),
      time_of_day TEXT NOT NULL DEFAULT '05:00',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      days_of_week_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
      day_of_month INTEGER NOT NULL DEFAULT 1,
      interval_hours INTEGER NOT NULL DEFAULT 24,
      to_json TEXT NOT NULL DEFAULT '[]',
      cc_json TEXT NOT NULL DEFAULT '[]',
      bcc_json TEXT NOT NULL DEFAULT '[]',
      subject TEXT NOT NULL,
      body_text TEXT NOT NULL DEFAULT '',
      body_html TEXT NOT NULL DEFAULT '',
      info_profile_ids_json TEXT NOT NULL DEFAULT '[]',
      attachment_ids_json TEXT NOT NULL DEFAULT '[]',
      max_runs INTEGER,
      run_count INTEGER NOT NULL DEFAULT 0,
      last_run_at TEXT,
      next_run_at TEXT NOT NULL,
      last_status TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sched_auto_due ON scheduled_automations(enabled, next_run_at);
    CREATE INDEX IF NOT EXISTS idx_sched_auto_user ON scheduled_automations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_automation_logs (
      id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL REFERENCES scheduled_automations(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('sent', 'failed', 'skipped')),
      detail TEXT NOT NULL DEFAULT '',
      executed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sched_logs_user ON scheduled_automation_logs(user_id, executed_at DESC);
  `);

  runSchemaMigrations(db);
}

function getColumnNames(db: DatabaseSync, tableName: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function runSchemaMigrations(db: DatabaseSync): void {
  const userCols = getColumnNames(db, 'users');
  if (!userCols.has('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member';");
  }
  if (!userCols.has('status')) {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';");
  }
  if (!userCols.has('quota_mb')) {
    db.exec('ALTER TABLE users ADD COLUMN quota_mb INTEGER NOT NULL DEFAULT 1024;');
  }

  // Ensure an existing workspace has at least one admin user
  const adminCount = db.prepare("SELECT COUNT(*) AS cnt FROM users WHERE role = 'admin'").get() as { cnt: number };
  if (adminCount.cnt === 0) {
    db.exec("UPDATE users SET role = 'admin' WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1);");
  }

  const msgCols = getColumnNames(db, 'messages');
  if (!msgCols.has('delivery_status')) {
    db.exec("ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'synced';");
  }
  if (!msgCols.has('delivery_detail')) {
    db.exec("ALTER TABLE messages ADD COLUMN delivery_detail TEXT NOT NULL DEFAULT '';");
  }

  const contactCols = getColumnNames(db, 'contacts');
  if (!contactCols.has('account_id')) {
    db.exec('ALTER TABLE contacts ADD COLUMN account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL;');
  }
  if (!contactCols.has('remote_id')) {
    db.exec('ALTER TABLE contacts ADD COLUMN remote_id TEXT;');
  }
  if (!contactCols.has('source')) {
    db.exec("ALTER TABLE contacts ADD COLUMN source TEXT NOT NULL DEFAULT 'local';");
  }
  if (!contactCols.has('custom_fields_json')) {
    db.exec("ALTER TABLE contacts ADD COLUMN custom_fields_json TEXT NOT NULL DEFAULT '{}';");
  }

  const queueCols = getColumnNames(db, 'mail_queue');
  if (!queueCols.has('idempotency_key')) {
    db.exec("ALTER TABLE mail_queue ADD COLUMN idempotency_key TEXT NOT NULL DEFAULT '';");
  }
  const mqSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mail_queue'")
    .get() as { sql?: string } | undefined;
  if (mqSqlRow?.sql && !mqSqlRow.sql.includes("'dead_letter'")) {
    db.exec(`
      BEGIN;
      CREATE TABLE mail_queue_migrated (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        draft_id TEXT,
        message_id TEXT,
        from_address TEXT NOT NULL COLLATE NOCASE,
        recipients_json TEXT NOT NULL,
        subject TEXT NOT NULL DEFAULT '',
        raw_mime_path TEXT NOT NULL DEFAULT '',
        message_id_header TEXT NOT NULL DEFAULT '',
        delivery_mode TEXT NOT NULL DEFAULT 'hosted_mx' CHECK(delivery_mode IN ('hosted_mx', 'smtp_relay', 'internal', 'provider_api')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'accepted_local', 'accepted_by_mx', 'retry_pending', 'bounced', 'failed', 'dead_letter')),
        idempotency_key TEXT NOT NULL DEFAULT '',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at TEXT NOT NULL,
        remote_mx_host TEXT NOT NULL DEFAULT '',
        smtp_response TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      INSERT INTO mail_queue_migrated
      SELECT id, user_id, account_id, draft_id, message_id, from_address, recipients_json, subject,
             raw_mime_path, message_id_header, delivery_mode, status, COALESCE(idempotency_key, ''),
             attempts, max_attempts, next_attempt_at, remote_mx_host, smtp_response, last_error,
             created_at, updated_at, completed_at
      FROM mail_queue;
      DROP TABLE mail_queue;
      ALTER TABLE mail_queue_migrated RENAME TO mail_queue;
      CREATE INDEX IF NOT EXISTS idx_mail_queue_due ON mail_queue(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_mail_queue_user ON mail_queue(user_id, created_at DESC);
      COMMIT;
    `);
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_mail_queue_idemp ON mail_queue(user_id, idempotency_key);');

  // Upgrade existing accounts table if built prior to hosted/yahoo/ownership columns
  const acctSqlRow = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'accounts'")
    .get() as { sql?: string } | undefined;
  const acctCols = getColumnNames(db, 'accounts');
  if (!acctCols.has('account_ownership') || (acctSqlRow?.sql && !acctSqlRow.sql.includes("'hosted'"))) {
    db.exec('PRAGMA foreign_keys = OFF;');
    try {
      db.exec(`
        BEGIN;
        CREATE TABLE accounts_migrated (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          provider_type TEXT NOT NULL CHECK(provider_type IN ('hosted', 'local', 'gmail', 'outlook', 'yahoo', 'imap_smtp')),
          account_ownership TEXT NOT NULL DEFAULT 'external' CHECK(account_ownership IN ('hosted', 'external')),
          domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
          email_address TEXT NOT NULL COLLATE NOCASE,
          display_name TEXT NOT NULL,
          avatar_color TEXT NOT NULL DEFAULT '#1D4ED8',
          signature_html TEXT NOT NULL DEFAULT '',
          signature_enabled INTEGER NOT NULL DEFAULT 1,
          status TEXT NOT NULL DEFAULT 'connected' CHECK(status IN ('connected', 'syncing', 'error', 'auth_expired', 'disconnected', 'suspended')),
          is_default INTEGER NOT NULL DEFAULT 0,
          quota_mb INTEGER NOT NULL DEFAULT 1024,
          used_bytes INTEGER NOT NULL DEFAULT 0,
          capabilities_json TEXT NOT NULL,
          encrypted_credentials TEXT NOT NULL DEFAULT '',
          sync_cursor TEXT NOT NULL DEFAULT '',
          last_synced_at TEXT,
          last_error TEXT,
          notification_prefs_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(user_id, email_address)
        );
        INSERT INTO accounts_migrated (
          id, user_id, provider_type, account_ownership, domain_id, email_address, display_name,
          avatar_color, signature_html, signature_enabled, status, is_default, quota_mb, used_bytes,
          capabilities_json, encrypted_credentials, sync_cursor, last_synced_at, last_error,
          notification_prefs_json, created_at, updated_at
        )
        SELECT
          id, user_id, provider_type,
          CASE WHEN provider_type IN ('hosted', 'local') THEN 'hosted' ELSE 'external' END,
          NULL, email_address, display_name, avatar_color, signature_html, signature_enabled, status,
          0, 1024, 0, capabilities_json, encrypted_credentials, sync_cursor, last_synced_at, last_error,
          notification_prefs_json, created_at, updated_at
        FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_migrated RENAME TO accounts;
        CREATE INDEX IF NOT EXISTS idx_accounts_user ON accounts(user_id);
        COMMIT;
      `);
    } catch (err) {
      try {
        db.exec('ROLLBACK;');
      } catch {
        // ignore
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON;');
    }
  }
}
