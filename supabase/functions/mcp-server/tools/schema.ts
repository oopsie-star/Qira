import { ISSUE_PRIORITIES, ISSUE_TYPES, TASK_STATUSES } from '../types.ts'

export interface McpToolSchema {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  _meta?: Record<string, unknown>
}

// ChatGPT's Apps SDK file-input convention: a top-level input field listed
// here gets populated by ChatGPT itself with { download_url, file_id,
// mime_type?, file_name? } for whatever the user attached — the model never
// has to author raw bytes. See supabase/functions/mcp-server/tools/attachmentPaths.ts
// for the server side of this (resolveAttachmentBytes).
const FILE_PARAM_PROPERTY = {
  type: 'object',
  description:
    'File reference for clients that support the openai/fileParams convention (e.g. ChatGPT) — the server fetches the bytes from download_url itself. Use this OR content_base64, not both.',
  properties: {
    download_url: { type: 'string', description: 'Temporary URL the server fetches the file bytes from.' },
    file_id: { type: 'string' },
    mime_type: { type: 'string' },
    file_name: { type: 'string' },
  },
  required: ['download_url', 'file_id'],
}

// Claude and ChatGPT both reach this server through the same static
// credential — there is no transport-level way to tell them apart, so every
// write tool requires this self-declared field instead.
const AGENT_NAME_PROPERTY = {
  type: 'string',
  enum: ['claude', 'chatgpt'],
  description: 'Identify yourself: "claude" if you are Claude, "chatgpt" if you are ChatGPT.',
}

const CONFIRMED_CROSS_AGENT_PROPERTY = {
  type: 'boolean',
  description:
    'Only set this to true after the human operator has explicitly confirmed the change, in response to this same call being rejected for a cross-agent conflict. Omit otherwise.',
}

// Integrity and chunking, shared by every tool that receives a file. One wrong
// character in hand-copied base64 used to corrupt a file silently; now the
// server hashes what it got and refuses a mismatch before saving anything.
const UPLOAD_INTEGRITY_PROPERTIES = {
  expected_md5: {
    type: 'string',
    description: 'MD5 of the whole file, 32 hex chars. Strongly recommended with content_base64: if what arrives hashes differently, nothing is saved and you get an error. The response always reports the md5 and size it stored.',
  },
  total_chunks: {
    type: 'integer',
    description: 'For large base64 files: split the bytes into 2-64 parts and send one call per part. Send chunk 0 first — its response carries upload_id — then the rest with that upload_id. The file is attached when the last part arrives.',
  },
  chunk_index: { type: 'integer', description: 'Which part this call carries, 0-based. Only with total_chunks.' },
  upload_id: { type: 'string', description: 'From the response to chunk 0. Required for every later chunk.' },
  chunk_md5: { type: 'string', description: 'Optional MD5 of this part alone; a mismatch rejects just this part so you can resend it.' },
}

const MAP_DISCIPLINES = ['backend', 'frontend', 'design', 'qa']

const CROSS_AGENT_NOTE =
  ' If this item was last modified by a different AI (Claude vs ChatGPT vs the in-app assistant), this call is rejected until the human operator confirms — then retry with confirmed_cross_agent: true.'

export const TOOL_SCHEMAS: McpToolSchema[] = [
  {
    name: 'list_tasks',
    description: 'List tasks in a project, optionally filtered by status and/or assignee. Archived and deleted tasks are left out unless you pass include_archived: true or ask for one of those statuses by name.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key, e.g. "PROJ".' },
        status: { type: 'string', enum: TASK_STATUSES },
        assignee_email: { type: 'string', description: 'Filter to tasks assigned (solely or jointly) to this person.' },
        include_archived: {
          type: 'boolean',
          description: 'Also return archived and deleted tasks, each marked archived: true. Omit for the working area only.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'get_task',
    description:
      'Get full details of a task: description, status, live comments (each with its id), live attachments, change history, and last_ai_agent (which AI — claude/chatgpt/qira-assistant — last modified it, and when). Archived comments and files are counted (archived_comments_count, archived_attachments_count) and listed only with include_archived. superseded_by / supersedes list only live tasks; links to archived tasks are in supersede_history and do not make this task obsolete.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key (e.g. "PROJ-42") or id (uuid).' },
        include_archived: {
          type: 'boolean',
          description: 'Also list archived comments and archived attachments (with when, by whom, and why). For an archived or deleted task, return its full contents — without it such a task answers with a short summary and counts only.',
        },
      },
      required: ['task'],
    },
  },
  {
    name: 'create_task',
    description: 'Create a new task in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        title: { type: 'string' },
        description: { type: 'string' },
        issue_type: { type: 'string', enum: ISSUE_TYPES },
        priority: { type: 'string', enum: ISSUE_PRIORITIES },
        assignee_email: { type: 'string' },
        epic: { type: 'string', description: 'Epic key or title, resolved within the project.' },
        sprint: { type: 'string', description: 'Sprint name, resolved within the project.' },
        implements_screen: {
          type: 'string',
          description:
            "Key or id of the screen this task builds — a task in the project's screen-registry epic (see list_design_screens). Use it on frontend tasks written for a finished design, so the screen shows what is already being built.",
        },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['project', 'title', 'agent_name'],
    },
  },
  {
    name: 'list_design_screens',
    description:
      "The project's screens and how far the design has got with each. Screens are the tasks inside the epic flagged as the screen registry: a screen marked done means the designer finished it and it is ready to build. Read this before writing frontend tasks — a screen that is not ready has no settled design to implement — and check `implemented_by` so you add what is missing instead of repeating work.",
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        only_ready: { type: 'boolean', description: 'Return only screens the designer has finished.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'update_task_status',
    description: `Change a task's status. For any other field, use update_task instead.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key or id.' },
        status: { type: 'string', enum: TASK_STATUSES },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['task', 'status', 'agent_name'],
    },
  },
  {
    name: 'update_task',
    description:
      `Update a task's title, description, priority, due date, assignee, epic, sprint, or labels. For status changes, use update_task_status instead.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key or id.' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ISSUE_PRIORITIES },
        due_date: { type: 'string', description: 'ISO date, e.g. "2026-08-20".' },
        assignee_email: { type: 'string' },
        epic: { type: 'string', description: 'Epic key or title, resolved within the project. Empty string clears it.' },
        sprint: { type: 'string', description: 'Sprint name, resolved within the project. Empty string clears it.' },
        labels: { type: 'array', items: { type: 'string' } },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['task', 'agent_name'],
    },
  },
  {
    name: 'get_project',
    description:
      'Get a project\'s epics, sprints (each with their attachments and last_ai_agent), and members.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
      },
      required: ['project'],
    },
  },
  {
    name: 'create_epic',
    description: 'Create a new epic in a project.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        title: { type: 'string' },
        description: { type: 'string' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['project', 'title', 'agent_name'],
    },
  },
  {
    name: 'create_sprint',
    description: 'Create a new sprint in a project, optionally under an epic.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        name: { type: 'string' },
        goal: { type: 'string' },
        epic: { type: 'string', description: 'Epic key or title, resolved within the project.' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['project', 'name', 'agent_name'],
    },
  },
  {
    name: 'attach_task_file',
    description:
      `Attach a file to a task (max 20MB). Provide the file via "file" (preferred if your client supports openai/fileParams — e.g. ChatGPT) or "content_base64" (raw file content, base64-encoded — e.g. Claude Code, which reads the file itself). With content_base64, pass expected_md5; for a large file, send it in chunks (total_chunks). To replace an existing file with a new version use replace_attachment — it archives the old one. Do NOT rename old files to "УСТАРЕЛО": archive them.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key or id.' },
        filename: { type: 'string', description: 'Original filename, e.g. "spec.pdf" — any script, does not need to be ASCII.' },
        file: FILE_PARAM_PROPERTY,
        content_base64: { type: 'string', description: 'Raw file bytes, base64-encoded. Use this OR file, not both.' },
        mime_type: { type: 'string', description: 'Optional MIME type, e.g. "application/pdf". Falls back to file.mime_type.' },
        ...UPLOAD_INTEGRITY_PROPERTIES,
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['task', 'filename', 'agent_name'],
    },
    _meta: { 'openai/fileParams': ['file'] },
  },
  {
    name: 'attach_epic_file',
    description: `Attach a file to an epic (max 20MB). See attach_task_file for the file/content_base64 details.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        epic: { type: 'string', description: 'Epic key or title.' },
        filename: { type: 'string' },
        file: FILE_PARAM_PROPERTY,
        content_base64: { type: 'string', description: 'Raw file bytes, base64-encoded. Use this OR file, not both.' },
        mime_type: { type: 'string' },
        ...UPLOAD_INTEGRITY_PROPERTIES,
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['project', 'epic', 'filename', 'agent_name'],
    },
    _meta: { 'openai/fileParams': ['file'] },
  },
  {
    name: 'attach_sprint_file',
    description: `Attach a file to a sprint (max 20MB). See attach_task_file for the file/content_base64 details.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        sprint: { type: 'string', description: 'Sprint name.' },
        filename: { type: 'string' },
        file: FILE_PARAM_PROPERTY,
        content_base64: { type: 'string', description: 'Raw file bytes, base64-encoded. Use this OR file, not both.' },
        mime_type: { type: 'string' },
        ...UPLOAD_INTEGRITY_PROPERTIES,
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['project', 'sprint', 'filename', 'agent_name'],
    },
    _meta: { 'openai/fileParams': ['file'] },
  },
  {
    name: 'archive_attachment',
    description:
      `Move an attachment to the archive — out of the task/epic/sprint's live file list, but kept and restorable with restore_attachment. Use this for files that are outdated or superseded instead of renaming them. Safe to repeat.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The attachment path, from get_task/get_project.' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['path', 'agent_name'],
    },
  },
  {
    name: 'restore_attachment',
    description:
      `Bring an archived attachment back into the live file list. Archived paths are listed by get_task with include_archived: true. Safe to repeat.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The archived attachment path.' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['path', 'agent_name'],
    },
  },
  {
    name: 'replace_attachment',
    description:
      `Upload a new version of an attachment and archive the old one in a single step — the way to publish "v2 of this package". The new file goes to the same task/epic/sprint and keeps the old file's name unless you give filename. The old file is archived only after the new one is fully stored and its checksum matches, so a failed upload leaves everything as it was.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        old_path: { type: 'string', description: 'Path of the live attachment being replaced.' },
        filename: { type: 'string', description: 'Optional new filename; defaults to the old file name.' },
        file: FILE_PARAM_PROPERTY,
        content_base64: { type: 'string', description: 'Raw file bytes, base64-encoded. Use this OR file, not both.' },
        mime_type: { type: 'string', description: 'Optional MIME type.' },
        ...UPLOAD_INTEGRITY_PROPERTIES,
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['old_path', 'agent_name'],
    },
    _meta: { 'openai/fileParams': ['file'] },
  },
  {
    name: 'rename_attachment',
    description:
      `Rename an attachment (works for task, epic, or sprint attachments alike — pass the path from get_task/get_project's attachments list). Renaming is for fixing a name — to retire an old version use archive_attachment or replace_attachment, never an "УСТАРЕЛО" prefix.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The attachment\'s storage path, from get_task/get_project.' },
        new_name: { type: 'string' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['path', 'new_name', 'agent_name'],
    },
  },
  {
    name: 'add_comment',
    description: `Add a comment to a task.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task key or id.' },
        body: { type: 'string' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['task', 'body', 'agent_name'],
    },
  },
  {
    name: 'archive_comment',
    description:
      `Move a comment out of the task's working area into its archive — kept, and restorable with restore_comment. Use it for comments that are outdated, resolved, or whose content you have moved into the description (then pass folded_into_description: true). Nothing is deleted. Safe to repeat.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        comment: { type: 'string', description: 'The comment id, from the comments list of get_task.' },
        folded_into_description: {
          type: 'boolean',
          description: 'True when the content of the comment now lives in the task description (you updated the description with it).',
        },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['comment', 'agent_name'],
    },
  },
  {
    name: 'restore_comment',
    description:
      `Bring an archived comment back into the task's working area. Archived comments, with their ids, are listed by get_task with include_archived: true. Safe to repeat.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        comment: { type: 'string', description: 'The archived comment id.' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['comment', 'agent_name'],
    },
  },
  {
    name: 'update_comment',
    description:
      `Rewrite a comment an AI agent wrote — to fix or complete it rather than adding another comment. People's comments cannot be edited this way. The previous text is kept in the comment's edit history.${CROSS_AGENT_NOTE}`,
    inputSchema: {
      type: 'object',
      properties: {
        comment: { type: 'string', description: 'The comment id, from the comments list of get_task.' },
        body: { type: 'string', description: 'The full new text of the comment.' },
        agent_name: AGENT_NAME_PROPERTY,
        confirmed_cross_agent: CONFIRMED_CROSS_AGENT_PROPERTY,
      },
      required: ['comment', 'body', 'agent_name'],
    },
  },
  {
    name: 'read_attachment',
    description:
      'Download an existing attachment\'s raw content as base64 — works for any file type, including archives, but returns raw bytes only (you cannot browse/unzip an archive through this — just fetch it). Use the path from get_task/get_project\'s attachments list.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The attachment\'s storage path, from get_task/get_project.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'mark_task_superseded',
    description:
      'Mark a task as obsolete, replaced by a newer task — links them and sinks the old task toward the bottom of the backlog, instead of manually prefixing its title with "[устарело]".',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The OLD task (key or id) that is now obsolete.' },
        superseded_by: { type: 'string', description: 'The NEW task (key or id) that replaces it.' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['task', 'superseded_by', 'agent_name'],
    },
  },
  {
    name: 'unlink_supersedes',
    description:
      'Remove the supersedes link between two tasks — the undo for mark_task_superseded. Give the two tasks in either order. Use it when a task was marked obsolete by mistake, or still points at a replacement that has since been archived.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'One of the two linked tasks (key or id).' },
        other: { type: 'string', description: 'The other linked task (key or id).' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['task', 'other', 'agent_name'],
    },
  },
  {
    name: 'search_tasks',
    description: 'Search tasks by a substring match on title and description. Archived and deleted tasks are left out unless you pass include_archived: true.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        project: { type: 'string', description: 'Optional — restrict to one project by key.' },
        include_archived: {
          type: 'boolean',
          description: 'Also return archived and deleted tasks, each marked archived: true. Omit for the working area only.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_projects',
    description:
      'List every project in Qira, including empty ones with no tasks yet. Call this whenever you are unsure what projects exist, or before guessing a project key.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'create_project',
    description:
      'Create a new project. State the project name and key back to the human operator and get their go-ahead before calling this — creating the wrong project is hard to undo cleanly.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        key: { type: 'string', description: 'Short uppercase key, e.g. "PROJ". Auto-generated from name if omitted.' },
        description: { type: 'string' },
        owner_email: { type: 'string', description: 'Email of the profile who should own this project.' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['name', 'owner_email', 'agent_name'],
    },
  },
  {
    name: 'get_project_map',
    description:
      'Read the Project Map: per-discipline (backend/frontend/design/qa) blocks of structured project knowledge, each with its linked tasks/epics and the questions and answers attached to it. Call this before writing to the map so you update existing blocks instead of duplicating them.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        discipline: {
          type: 'string',
          enum: MAP_DISCIPLINES,
          description: 'Optional — restrict to one discipline.',
        },
      },
      required: ['project'],
    },
  },
  {
    name: 'upsert_project_map_block',
    description:
      'Create or replace one Project Map block — a titled piece of structured knowledge (markdown body) for one discipline, optionally linked to the tasks and epics it derives from. Identified by block_id when given, otherwise by (project, discipline, title): re-running with the same title updates that block rather than adding a second one. Derive the content from the project\'s tasks, epics and canon — never invent architecture or rules that are not in the project data.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project key.' },
        discipline: { type: 'string', enum: MAP_DISCIPLINES },
        title: { type: 'string', description: 'Block heading — also its identity within the discipline when block_id is omitted.' },
        body: { type: 'string', description: 'Markdown body of the block.' },
        block_id: { type: 'string', description: 'Update this exact block (from get_project_map). Omit to match on title.' },
        covers_discipline: {
          type: 'string',
          enum: ['design', 'backend', 'frontend'],
          description:
            'QA blocks only: whose work this QA material covers. Set it — it is what lets those authors (not just testers) ask questions on the block. Rejected on non-QA blocks.',
        },
        linked_tasks: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task keys (e.g. "PROJ-42") or ids this block derives from. Replaces the existing set.',
        },
        linked_epics: {
          type: 'array',
          items: { type: 'string' },
          description: 'Epic keys, titles, or ids this block derives from. Replaces the existing set.',
        },
        position: { type: 'number', description: 'Sort order within the discipline (ascending).' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['project', 'discipline', 'title', 'agent_name'],
    },
  },
  {
    name: 'delete_project_map_block',
    description: 'Delete a Project Map block and the questions and answers attached to it. Confirm with the human operator first.',
    inputSchema: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: 'Block id from get_project_map.' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['block_id', 'agent_name'],
    },
  },
  {
    name: 'post_project_map_qa',
    description:
      'Post a question on a Project Map block, or answer an existing question by passing answer_to. Q&A is always bound to one block, so answer the question in terms of that block\'s content and the project data behind it.',
    inputSchema: {
      type: 'object',
      properties: {
        block_id: { type: 'string', description: 'Block to ask about. Ignored (inherited from the question) when answer_to is set.' },
        answer_to: { type: 'string', description: 'Question id being answered — omit to post a new question.' },
        body: { type: 'string' },
        agent_name: AGENT_NAME_PROPERTY,
      },
      required: ['body', 'agent_name'],
    },
  },
]
