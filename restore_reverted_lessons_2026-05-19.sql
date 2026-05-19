begin;

-- Reinsert lessons that are present in the local audit log but missing from production.
insert into public.lessons (id, title, date, start_minute, duration_minutes, horse_id, horse_name, instructor_id, instructor_name, recurring, recurring_until, lesson_type, package_mode, group_name, group_color, participants, cancelled_dates, deducted_dates, instance_overrides, created_at, updated_at)
values
('d2c1cb60-b2d4-4919-9708-18185d729368', 'Anielka i Michasia', '2026-05-12', 660, 90, null, null, null, null, false, null, 'individual', false, 'Anielka i Michasia', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-06T15:34:35.414Z'::timestamptz, '2026-05-06T15:34:35.414Z'::timestamptz),
('a8e601f2-6b90-435a-ac37-4a27ceb868a6', 'Anielka i Michasia', '2026-05-13', 1140, 60, null, null, null, null, false, null, 'individual', false, 'Anielka i Michasia', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-11T13:24:57.775Z'::timestamptz, '2026-05-11T13:24:57.775Z'::timestamptz),
('a07f844b-ee78-41aa-a177-73b1bc266b9f', 'Marcin', '2026-05-14', 660, 60, null, null, null, null, false, null, 'individual', false, 'Marcin', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-07T12:43:14.906Z'::timestamptz, '2026-05-07T12:43:14.906Z'::timestamptz),
('4baac6db-ae08-4896-acb9-8051b3e163dd', 'Grupowa', '2026-05-17', 960, 60, null, null, null, null, true, null, 'group', true, null, null, $json$[{"name":"Wiktoria","horse":null,"packageMode":false},{"name":"Stasiu","horse":null,"packageMode":false}]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-16T21:36:06.295Z'::timestamptz, '2026-05-16T21:36:11.697Z'::timestamptz),
('6d419270-ddab-4754-b7d9-16a37cd31e7f', 'Niestandardowa', '2026-05-17', 1020, 60, null, null, null, null, false, null, 'custom', false, 'Niestandardowa', null, $json$[{"name":"Siostra","horse":"Sakwa","packageName":"Siostra","packageMode":false,"instructor":"Olga","customCost":110},{"name":"Siostra","horse":"Carewicz","packageName":"Siostra","packageMode":false,"instructor":"Olga","customCost":110}]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-17T12:44:25.196Z'::timestamptz, '2026-05-17T12:44:25.196Z'::timestamptz),
('f708db3b-3baf-4013-90ed-61ce94cee9ab', 'Ada', '2026-05-19', 720, 45, null, null, null, null, false, null, 'individual', false, 'Ada', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-19T08:08:03.454Z'::timestamptz, '2026-05-19T08:08:03.454Z'::timestamptz),
('dca3ff83-a3be-46d8-af4c-d301fdc98b67', 'Anielka i Michasia', '2026-05-19', 1020, 60, null, null, null, null, false, null, 'individual', false, 'Anielka i Michasia', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-18T08:13:10.840Z'::timestamptz, '2026-05-18T08:13:10.840Z'::timestamptz),
('5d665d21-8bc6-4da0-a0fd-a68a96a48cab', 'Grupowa', '2026-05-19', 1080, 60, null, null, null, null, false, null, 'group', true, 'Grupowa', null, $json$[{"name":"Damian Dedła","horse":null,"packageName":"Damian Dedła","packageMode":true,"instructor":null},{"name":"Marianka","horse":null,"packageName":"Marianka","packageMode":true,"instructor":null},{"name":"Nadia","horse":null,"packageName":"Nadia","packageMode":true,"instructor":null}]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-18T13:38:06.244Z'::timestamptz, '2026-05-18T13:38:06.244Z'::timestamptz),
('16763b9c-a597-4ec9-a487-a00cbd58e6e4', 'Lilka od Oliwki', '2026-05-20', 1140, 60, null, null, (select id from public.instructors where name = 'Olga' limit 1), 'Olga', false, null, 'individual', false, 'Lilka od Oliwki', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-16T09:54:16.399Z'::timestamptz, '2026-05-16T09:54:16.399Z'::timestamptz),
('cde74399-571a-4501-94ff-ff3ceaf0d97d', 'Oliwka Lilki', '2026-05-20', 1140, 60, (select id from public.horses where name = 'Figa' limit 1), 'Figa', null, null, false, null, 'individual', false, 'Oliwka Lilki', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-16T09:54:37.569Z'::timestamptz, '2026-05-16T09:54:37.569Z'::timestamptz),
('63f4837c-2c05-4ffe-b0da-64b4e3295638', 'Marcin', '2026-05-28', 660, 60, null, null, null, null, false, null, 'individual', false, 'Marcin', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-19T10:14:58.089Z'::timestamptz, '2026-05-19T10:14:58.089Z'::timestamptz),
('bab05a92-0538-4146-bf5b-57f206945088', 'Marta Mama Szymona', '2026-05-28', 1020, 60, null, null, (select id from public.instructors where name = 'Ania' limit 1), 'Ania', false, null, 'individual', true, null, null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-17T12:26:16.647Z'::timestamptz, '2026-05-17T12:26:52.244Z'::timestamptz),
('6c2951da-b776-4656-a0ce-19f8978f49d4', 'Tosia', '2026-05-30', 930, 60, (select id from public.horses where name = 'Rubin' limit 1), 'Rubin', null, null, false, null, 'individual', false, 'Tosia', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-18T13:06:57.082Z'::timestamptz, '2026-05-18T13:06:57.082Z'::timestamptz),
('c35f41d5-beb1-432e-8c3e-0272b339afcb', 'Marysia', '2026-05-30', 930, 60, null, null, null, null, false, null, 'individual', false, 'Marysia', null, $json$[]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-18T13:07:19.547Z'::timestamptz, '2026-05-18T13:07:19.547Z'::timestamptz),
('f1141c6f-9b06-406f-a400-23cb317120c4', 'Niestandardowa', '2026-05-30', 1080, 60, null, null, null, null, false, null, 'custom', false, 'Niestandardowa', null, $json$[{"name":"Tosia i Marysia","horse":null,"packageName":"Tosia i Marysia","packageMode":false,"instructor":null,"customCost":140}]$json$::jsonb, $json$[]$json$::jsonb, $json$[]$json$::jsonb, '{}'::jsonb, '2026-05-16T12:03:01.550Z'::timestamptz, '2026-05-16T12:03:01.550Z'::timestamptz)
on conflict (id) do update set
  title = excluded.title,
  date = excluded.date,
  start_minute = excluded.start_minute,
  duration_minutes = excluded.duration_minutes,
  horse_id = excluded.horse_id,
  horse_name = excluded.horse_name,
  instructor_id = excluded.instructor_id,
  instructor_name = excluded.instructor_name,
  recurring = excluded.recurring,
  recurring_until = excluded.recurring_until,
  lesson_type = excluded.lesson_type,
  package_mode = excluded.package_mode,
  group_name = excluded.group_name,
  group_color = excluded.group_color,
  participants = excluded.participants,
  cancelled_dates = excluded.cancelled_dates,
  deducted_dates = excluded.deducted_dates,
  instance_overrides = excluded.instance_overrides;

-- Reapply user-visible lesson edits that the export shows as reverted.
update public.lessons
set title = 'Lilka od Oliwki',
    date = '2026-05-07',
    start_minute = 900,
    duration_minutes = 60,
    horse_name = 'Kadet',
    horse_id = (select id from public.horses where name = 'Kadet' limit 1),
    instructor_name = 'Olga',
    instructor_id = (select id from public.instructors where name = 'Olga' limit 1),
    lesson_type = 'individual',
    package_mode = true,
    group_name = null,
    group_color = null,
    participants = $json$[]$json$::jsonb,
    recurring = false
where id = '2f0baf4b-cc4d-4288-b493-ed5294da215d';

update public.lessons
set title = 'Niestandardowa',
    date = '2026-05-10',
    start_minute = 660,
    duration_minutes = 60,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'custom',
    package_mode = false,
    group_name = null,
    group_color = null,
    participants = $json$[{"name":"27latla npwa","horse":"Carewicz","instructor":null,"customCost":140,"packageMode":false}]$json$::jsonb,
    recurring = false
where id = 'db36b966-0f37-44dc-b59e-feb32bc6bd86';

update public.lessons
set title = 'Grupowa',
    date = '2026-05-10',
    start_minute = 840,
    duration_minutes = 60,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'group',
    package_mode = true,
    group_name = null,
    group_color = '#FFD600',
    participants = $json$[{"name":"Stasiu","horse":"Fason","packageMode":true},{"name":"Wiktoria","horse":"Kadet","packageMode":true}]$json$::jsonb,
    recurring = false
where id = '79558257-3d78-449f-976b-ab2c2002fcc9';

update public.lessons
set title = 'Niestandardowa',
    date = '2026-05-10',
    start_minute = 1020,
    duration_minutes = 120,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'custom',
    package_mode = false,
    group_name = null,
    group_color = null,
    participants = $json$[{"name":"Nowa Pani","horse":"Carewicz","instructor":null,"customCost":140,"packageMode":false}]$json$::jsonb,
    recurring = false
where id = '1eee68e4-90d0-47e4-9579-eafc69250e22';

update public.lessons
set title = 'Niestandardowa',
    date = '2026-05-10',
    start_minute = 960,
    duration_minutes = 45,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'custom',
    package_mode = false,
    group_name = null,
    group_color = null,
    participants = $json$[{"name":"3,5 roku","horse":"Czempion","instructor":null,"customCost":140,"packageMode":false}]$json$::jsonb,
    recurring = false
where id = 'cf2a8596-52cb-4db6-81c7-cb3b485b2a47';

update public.lessons
set title = 'Niestandardowa',
    date = '2026-05-10',
    start_minute = 900,
    duration_minutes = 60,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'custom',
    package_mode = false,
    group_name = null,
    group_color = null,
    participants = $json$[{"name":"11 latka 1 raz","horse":"Muminek","instructor":null,"customCost":140,"packageMode":false}]$json$::jsonb,
    recurring = false
where id = 'b0141dad-5de5-4014-84aa-d720497a81fb';

update public.lessons
set title = 'Grupowa',
    date = '2026-05-13',
    start_minute = 660,
    duration_minutes = 60,
    horse_name = null,
    horse_id = null,
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'group',
    package_mode = true,
    group_name = null,
    group_color = '#76FF03',
    participants = $json$[{"name":"Gosia","horse":null,"packageMode":false},{"name":"Klaudia","horse":null,"packageMode":false}]$json$::jsonb,
    recurring = false
where id = '1ba188e2-d0ff-4973-abc2-793b4d36d95c';

update public.lessons
set title = 'Lilka od Oliwki',
    date = '2026-05-16',
    start_minute = 690,
    duration_minutes = 60,
    horse_name = 'Carewicz',
    horse_id = (select id from public.horses where name = 'Carewicz' limit 1),
    instructor_name = 'Ania',
    instructor_id = (select id from public.instructors where name = 'Ania' limit 1),
    lesson_type = 'individual',
    package_mode = true,
    group_name = null,
    group_color = null,
    participants = $json$[]$json$::jsonb,
    recurring = false
where id = 'd39cb5b3-f009-463d-972d-685c04acf305';

update public.lessons
set title = 'Oliwka Lilki',
    date = '2026-05-16',
    start_minute = 690,
    duration_minutes = 60,
    horse_name = 'Czempion',
    horse_id = (select id from public.horses where name = 'Czempion' limit 1),
    instructor_name = null,
    instructor_id = null,
    lesson_type = 'individual',
    package_mode = true,
    group_name = null,
    group_color = null,
    participants = $json$[]$json$::jsonb,
    recurring = false
where id = '3e7391c8-5579-432b-95f7-0fbca5806b85';

update public.lessons
set title = 'Oliwia Olszewska 1 kazda',
    date = '2026-05-17',
    start_minute = 840,
    duration_minutes = 60,
    horse_name = null,
    horse_id = null,
    instructor_name = 'Olga',
    instructor_id = (select id from public.instructors where name = 'Olga' limit 1),
    lesson_type = 'individual',
    package_mode = false,
    group_name = null,
    group_color = null,
    participants = $json$[]$json$::jsonb,
    recurring = false
where id = '7b3c9a6b-ae25-402e-9c3d-580ddb6fc545';

commit;
