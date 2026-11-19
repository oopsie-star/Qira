// Stage 7 — the working rules agents read in tool descriptions and server
// instructions. If a rule's wording is lost in an edit, this fails.
//
// Run: deno test --no-check --allow-env toolRules.test.ts

import { assert, assertEquals, assertRejects } from 'https://deno.land/std@0.224.0/assert/mod.ts'

import { handleRequest } from './rpc.ts'
import { ToolError } from './tools/errors.ts'
import { isRetirementName, renameAttachment } from './tools/renameAttachment.ts'
import { TOOL_SCHEMAS } from './tools/schema.ts'

const desc = (name: string) => TOOL_SCHEMAS.find((t) => t.name === name)!.description

const RULES: [string, string[]][] = [
  ['update_task', ['BEFORE EDITING the title or description, call get_edit_policy', 'create_task_revision', 'possible_duplicates']],
  ['create_task_revision', ['never create a copy with create_task', 'get_edit_policy']],
  ['restore_description_version', ['get_edit_policy']],
  ['rename_attachment', ['archive_attachment', 'replace_attachment', '"УСТАРЕЛО"', 'is refused']],
  ['archive_attachment', ['instead of renaming']],
  ['add_comment', ['Requirements belong in the description']],
  ['archive_comment', ['first move it into the description', 'folded_into_description: true']],
  ['create_task', ['AFTER CREATING', 'possible_duplicates', 'resolve_duplicate', 'use create_task_revision']],
  ['get_task', ['comments_truncated.omitted > 0', 'all_comments']],
]

Deno.test('every rule is in its tool description', () => {
  for (const [tool, phrases] of RULES) for (const p of phrases) assert(desc(tool).includes(p), `${tool}: missing "${p}"`)
})

Deno.test('server instructions carry the whole working order', async () => {
  const res = await handleRequest({} as never, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) as { body: { result: { instructions: string } } }
  const text = res.body.result.instructions
  for (const p of ['get_edit_policy', 'all_comments', 'create_task_revision', 'folded_into_description', 'archive_attachment', 'possible_duplicates', 'resolve_duplicate', 'list_projects']) {
    assert(text.includes(p), `instructions: missing "${p}"`)
  }
})

Deno.test('retirement names are recognised in any case, after spaces and brackets', () => {
  for (const n of ['УСТАРЕЛО v1.zip', 'устарело_v1.zip', '  Устарело - x.pdf', '[УСТАРЕЛО] x', 'УСТАРЕЛО (битая копия) v1.2.1.zip', 'OUTDATED x', 'outdated', 'Out dated x', 'OUT_DATED-x', '[old] spec.pdf', 'OLD_v1.pdf', 'old-v2.zip', ' Old 2.pdf', 'OLD2.pdf']) {
    assertEquals(isRetirementName(n), true, n)
  }
  for (const n of ['Oldenburg map.pdf', 'Older notes.txt', 'spec OLD.pdf', 'v2 устарело.zip', 'gold.png', 'Устаревшие требования.pdf', 'design.fig']) {
    assertEquals(isRetirementName(n), false, n)
  }
})

Deno.test('rename_attachment refuses a retirement name and points to archive/replace', async () => {
  const err = await assertRejects(
    () => renameAttachment({} as never, { path: 'p/t/u/1-a.zip', new_name: ' устарело a.zip', agent_name: 'claude' }),
    ToolError,
  )
  assert(String((err as Error).message).includes('archive_attachment') && String((err as Error).message).includes('replace_attachment'))
})
