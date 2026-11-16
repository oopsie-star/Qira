// The column lists the app reads with — one place, so the production smoke
// check (scripts/prodSmoke.ts) sends exactly what the screens send. A schema
// change that breaks one of these (a dropped column, an embed made ambiguous by
// a second foreign key) fails that check right after the migration.

export const TASK_SELECT = `
  *,
  epic:epics(*),
  assignee:profiles!tasks_assignee_id_fkey(*),
  reporter:profiles!tasks_reporter_id_fkey(*)
`

export const ACTIVITY_EVENT_SELECT = `
  id, project_id, profile_id, event_type, task_id, detail, created_at,
  profile:profiles(id, full_name, email),
  task:tasks(id, key, title)
`

export const AGENT_AUDIT_LOG_SELECT = `
  id, agent_type, agent_profile_id, project_id, task_id, action_type, payload, result, created_at,
  agent:profiles!agent_audit_log_agent_profile_id_fkey(id, full_name, email),
  task:tasks(id, key, title)
`

// `department` / `additional_departments` live on the membership (they used to
// be global, on `profiles`) — leave them out of these column lists and every
// edit writes to the DB fine but reads back as blank on the next fetch.
export const PROJECT_ACCESS_SELECT = `
  id,
  project_id,
  profile_id,
  project_role,
  department,
  additional_departments,
  created_at,
  project:projects(*)
`

export const PROJECT_MEMBER_SELECT = `
  id,
  project_id,
  profile_id,
  project_role,
  department,
  additional_departments,
  created_at,
  profile:profiles(*)
`

// The FK is named: task_comments has more than one column pointing at
// profiles over time, and an unnamed embed fails outright (PGRST201) when so.
export const TASK_COMMENT_SELECT = `
  *,
  author:profiles!task_comments_author_id_fkey(*)
`

export const TASK_ACTIVITY_SELECT = `
  *,
  actor:profiles(*)
`

export const TASK_LINK_SELECT = `
  *,
  source_task:tasks!task_links_source_task_id_fkey(id, key, title, status, assignee_id),
  target_task:tasks!task_links_target_task_id_fkey(id, key, title, status, assignee_id)
`

export const NOTIFICATION_SELECT = `
  *,
  task:tasks(id, key, title, status, assignee_id)
`

export const DELETION_REQUEST_SELECT = `
  *,
  requester:profiles(*),
  project:projects(id, key, name)
`

export const PROJECT_DELETION_REQUEST_SELECT = `
  *,
  requester:profiles(*),
  approvals:project_deletion_approvals(admin_id, approved_at)
`

export const TASK_FIELD_CHANGE_SELECT = `*, profile:profiles(id, full_name, email)`
