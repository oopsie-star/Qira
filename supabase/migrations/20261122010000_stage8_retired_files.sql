-- Stage 8 data migration, block 8.1 (files retired by an "УСТАРЕЛО" name). Generated from the dry-run plan that
-- was approved (2026-11-22); every change is written to data_migration_log with the
-- row before and after, so the block can be undone row by row. The block
-- checks its own counts against the dry-run and aborts as a whole if they differ.
--
-- 50 live files named "УСТАРЕЛО …": archived through set_attachment_archived
-- (the same function archive_attachment uses), the prefix dropped from the
-- name, the old name kept in retired_name. 14 name rows whose file no longer
-- exists in storage are removed. The "broken copy" of v1.2.1 in MOMNA-1071 is
-- NOT touched here: it is deleted through an owner request.

do $$
declare
  r        record;
  v_before jsonb;
  v_after  jsonb;
  v_n      integer := 0;
  v_o      integer := 0;
begin
  -- set_attachment_archived acts for the service role when no user is signed in.
  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);

  for r in select * from (values
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/0f33161b-a7b3-4c3f-97b3-123a0c7c29b7/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1786868964565-Propa_Backend_Core_Canon_v0.md', 'Propa_Backend_Core_Canon_v0.md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/ab7d2b67-3f75-4881-8ea7-ac43a2c68529/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1790188775512-01___________v4___2026-09-23.md', '01_Путь_пользователя_экраны_и_переходы_v4_КАНОН_2026-09-23.md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553093985-02_________Score_Evidence__.md', '02_Полный состав пользовательского анализа (заменён v4).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553109619-04__________.md', '04_Карта и публичный поиск (заменён v4).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553128481-Propa_____AI___v3.1_RU.md', 'Propa единый контракт AI анализа v3.1 (заменён v3.2 2026-09-23).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553094319-02_________Score_Evidence__.pdf', '02_Полный состав пользовательского анализа.pdf'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553102174-03_Library_Saved______.md', '03_Library Saved и обновление анализа (заменён v4).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553102529-03_Library_Saved______.pdf', '03_Library Saved и обновление анализа.pdf'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553109960-04__________.pdf', '04_Карта и публичный поиск.pdf'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553118261-05_____Identity_and_Evidence_Status_____v3_RU.pdf', '05_Публичные отчеты Identity Evidence Status v3.pdf'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553083477-01___________v2.md', '01_Путь пользователя v2.md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/5a8c58fd-9063-454c-a6c6-d6f5a7df75fc/1786224685470-01_user_journey_canon_v3.md', '01_Путь пользователя: экраны и переходы v3 (заменён v4 2026-09-23).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553118576-05_____Identity_and_Evidence_Status_____v3_RU.md', '05_Публичные отчеты Identity Evidence Status v3 (заменён v4).md'),
    ('fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/5a8c58fd-9063-454c-a6c6-d6f5a7df75fc/1785785831595-propa_consumer_flowmap_v3.png', 'propa_consumer_flowmap_v3.png'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6eb0adb9-5cc1-4335-a27b-9a6cae3a9733/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1787851833972-Momna_Calendar_Adult_Cycle_Design_Brief_RU.md', 'Momna_Calendar_Adult_Cycle_Design_Brief_RU.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6eb0adb9-5cc1-4335-a27b-9a6cae3a9733/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342612927-Momna_Calendar_Adult_Cycle_Design_Brief_RU_v1.3.md', 'adult-calendar-design-brief-v1.3-incomplete.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772847925-Momna_Menarche_Calendar_Content_Package_v1.1.zip', 'Momna_Menarche_Calendar_Content_Package_v1.1.zip'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772857941-menarche-calendar-content-v1.1.json', 'menarche-calendar-content-v1.1.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772858461-menarche-calendar-content-v1.1.schema.json', 'menarche-calendar-content-v1.1.schema.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772858681-menarche-calendar-frontend-contract-v1.1.ts', 'menarche-calendar-frontend-contract-v1.1.ts'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772858914-menarche-calendar-resolver-mapping-v1.1.yaml', 'menarche-calendar-resolver-mapping-v1.1.yaml'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772859481-Momna_Menarche_Calendar_Context_Content_Canon_US_EN_v1.1.md', 'Momna_Menarche_Calendar_Context_Content_Canon_US_EN_v1.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772859855-README_Menarche_Calendar_Content_v1.1.md', 'README_Menarche_Calendar_Content_v1.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348076577-Momna_Menarche_Calendar_Content_Package_v1.2_FINAL.zip', 'Momna_Menarche_Calendar_Content_Package_v1.2_FINAL.zip'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1788772859142-Momna_Menarche_Calendar_Context_Content_Canon_RU_v1.1.md', 'Momna_Menarche_Calendar_Context_Content_Canon_RU_v1.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348049170-menarche-calendar-content-v1.2.json', 'menarche-calendar-content-v1.2.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348052930-menarche-calendar-content-v1.2.schema.json', 'menarche-calendar-content-v1.2.schema.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348056437-menarche-calendar-resolver-mapping-v1.2.yaml', 'menarche-calendar-resolver-mapping-v1.2.yaml'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348060680-menarche-calendar-frontend-contract-v1.2.ts', 'menarche-calendar-frontend-contract-v1.2.ts'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348064542-Momna_Menarche_Calendar_Context_Content_Canon_RU_v1.2.md', 'Momna_Menarche_Calendar_Context_Content_Canon_RU_v1.2.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348068190-Momna_Menarche_Calendar_Context_Content_Canon_US_EN_v1.2.md', 'Momna_Menarche_Calendar_Context_Content_Canon_US_EN_v1.2.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348072189-README_Menarche_Calendar_Content_v1.2.md', 'README_Menarche_Calendar_Content_v1.2.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348190174-Momna_Menarche_Calendar_Content_Package_v1.2_SCHEMA_ALIGNED_FINAL.zip', 'Momna_Menarche_Calendar_Content_Package_v1.2_SCHEMA_ALIGNED_FINAL.zip'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/6a07bf68-e040-4a1d-a5db-dafa9b971938/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794348197807-menarche-calendar-content.schema.json', 'menarche-calendar-content.schema.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1789397610668-Yuliya_Adult_Calendar_QA_Content_v1.3.md', 'Yuliya_Adult_Calendar_QA_Content_v1.3.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561540104-adult-calendar-frontend-contract-v1.3.ts', 'adult-calendar-frontend-contract-v1.3.ts'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561519232-Momna_Adult_Calendar_Content_Package_v1.3_FINAL.zip', 'Momna_Adult_Calendar_Content_Package_v1.3_FINAL.zip'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561540650-Momna_Adult_Calendar_Context_Content_Canon_RU_v1.3.md', 'Momna_Adult_Calendar_Context_Content_Canon_RU_v1.3.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561541170-README_Adult_Calendar_Content_v1.3.md', 'README_Adult_Calendar_Content_v1.3.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561538977-adult-calendar-content-v1.3.json', 'adult-calendar-content-v1.3.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561539699-adult-calendar-content-v1.3.schema.json', 'adult-calendar-content-v1.3.schema.json'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561540386-adult-calendar-resolver-mapping-v1.3.yaml', 'adult-calendar-resolver-mapping-v1.3.yaml'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561541383-Yuliya_Adult_Calendar_QA_Content_v1.3.md', 'Yuliya_Adult_Calendar_QA_Content_v1.3.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1789561540934-Momna_Adult_Calendar_Context_Content_Canon_US_EN_v1.3.md', 'Momna_Adult_Calendar_Context_Content_Canon_US_EN_v1.3.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342607083-adult-calendar-frontend-contract-v1.3.1.ts', 'adult-calendar-frontend-contract-v1.3.1.ts'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342874610-Momna_Adult_Calendar_Content_Package_v1.3.1_FINAL.zip', 'Momna_Adult_Calendar_Content_Package_v1.3.1_FINAL.zip'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342877155-Momna_Adult_Calendar_Context_Content_Canon_RU_v1.3.1.md', 'Momna_Adult_Calendar_Context_Content_Canon_RU_v1.3.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342879352-Momna_Adult_Calendar_Context_Content_Canon_US_EN_v1.3.1.md', 'Momna_Adult_Calendar_Context_Content_Canon_US_EN_v1.3.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794342881362-README_Adult_Calendar_Content_v1.3.1.md', 'README_Adult_Calendar_Content_v1.3.1.md'),
    ('b593b7f1-037b-4401-8b15-5aab63ee1f5f/dbe97280-fd1e-4a7a-8ee4-02949dae7236/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1794351750441-Menarche_Frontend_API_Safety_Education_Handoff_v1_FINAL.md', 'Menarche_Frontend_API_Safety_Education_Handoff_v1_FINAL.md')
  ) v(path, new_name) loop
    select to_jsonb(n) into v_before from public.attachment_notes n where n.path = r.path;
    if v_before is null or coalesce(v_before->>'original_name', '') !~* '^[[:space:][:punct:]]*(устарело|out[ _-]*dated|old)' then
      raise exception '8.1: % is no longer named as retired (%), the plan is stale', r.path, v_before->>'original_name';
    end if;
    perform public.set_attachment_archived(r.path, true, null, 'stage8-migration');
    update public.attachment_notes
       set retired_name = original_name, original_name = r.new_name
     where path = r.path
     returning to_jsonb(attachment_notes) into v_after;
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('8.1', 'attachment_notes', r.path, 'archive_and_strip', v_before, v_after);
    v_n := v_n + 1;
  end loop;

  for r in select n.* from public.attachment_notes n
            where n.path in (
    'fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4eec-bc98-5f3ba31e8431/1784553083827-01___________v2..pdf',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/epics/31996de1-5928-437d-997a-edb08d5235dc/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1786795291717-Momna_AI_Agent_Platform_Canon_v1.0_RU.md',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109631751-adult-calendar-content-v1.1.json',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109632469-adult-calendar-resolver-mapping-v1.1.yaml',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109632616-Momna_Adult_Calendar_Context_Content_Canon_RU_v1.1.md',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109632808-Momna_Adult_Calendar_Context_Content_Canon_US_EN_v1.1.md',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109633254-README_Adult_Calendar_Content_v1.1.md',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109631964-adult-calendar-content-v1.1.schema.json',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/8db592d7-4ae8-489d-8a4a-6c0784f68fa6/b0c19131-61be-4cce-90fc-4d93002cf10d/1789109632156-adult-calendar-frontend-contract-v1.1.ts',
    'fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4e5e-b2f1-14ed33aa5731/1784553102174-03_Library_Saved______.md',
    'fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4e5e-b2f1-14ed33aa5731/1784553102529-03_Library_Saved______.pdf',
    'fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4e5e-b2f1-14ed33aa5731/1784553109960-04__________.pdf',
    'fc43adb5-a38c-4e5e-b2f1-14ed33aa5731/epics/bcba6eb4-319a-48b8-9aeb-2964ba38eaba/8e34a1b6-db93-4e5e-b2f1-14ed33aa5731/1784553118261-05_____Identity_and_Evidence_Status_____v3_RU.pdf',
    'b593b7f1-037b-4401-8b15-5aab63ee1f5f/6eb0adb9-5cc1-4335-a27b-9a6cae3a9733/a4df03f1-3bef-4118-ab64-98ddc7fb40cd/1789561540104-adult-calendar-frontend-contract-v1.3.ts'
            )
              and not exists (select 1 from storage.objects o where o.name = n.path) loop
    insert into public.data_migration_log (block, table_name, row_id, action, before, after)
    values ('8.1', 'attachment_notes', r.path, 'delete_name_without_file', to_jsonb(r), null);
    delete from public.attachment_notes where id = r.id;
    v_o := v_o + 1;
  end loop;

  perform set_config('request.jwt.claims', '', true);
  if v_n <> 50 or v_o <> 14 then
    raise exception '8.1: archived % (expected 50), removed % name rows (expected 14)', v_n, v_o;
  end if;
end;
$$;
