UPDATE `edit_jobs`
SET `state` = 'failed',
    `error_code` = 'NON_LIVE_MODE_REMOVED',
    `public_error_message` = 'This queued edit used a retired non-live renderer. Submit it again for live AI generation.',
    `worker_token` = NULL,
    `lease_expires_at` = NULL,
    `updated_at` = unixepoch() * 1000,
    `completed_at` = unixepoch() * 1000
WHERE `kind` = 'edit'
  AND `execution_mode` <> 'openai'
  AND `state` IN ('queued', 'moderating', 'generating', 'committing');
