-- Exquisite corpse: AI pen drawings of finished Words sentences.
-- Run this once in Supabase > SQL Editor > New query, after supabase-setup.sql.

create table if not exists ai_drawings (
  game_id    text primary key references games(id) on delete cascade,
  strokes    text not null check (length(strokes) < 200000),
  title      text not null default '' check (length(title) <= 80),
  created_at timestamptz not null default now()
);

create table if not exists ai_wall (
  game_id    text primary key references ai_drawings(game_id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table ai_drawings enable row level security;
alter table ai_wall     enable row level security;

-- Anyone may look. Only the pen-drawing function (server side) can add a drawing,
-- so nobody can post their own lines as "made by AI".
create policy "read ai drawings" on ai_drawings for select using (true);
create policy "read ai wall"     on ai_wall     for select using (true);
create policy "add ai to wall"   on ai_wall     for insert with check (true);
