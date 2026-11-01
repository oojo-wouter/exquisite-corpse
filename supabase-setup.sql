-- Exquisite corpse: database for games, turns and the public wall.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run.

create table if not exists games (
  id         text primary key check (id ~ '^[a-z0-9]{8}$'),
  edition    text not null check (edition in ('draw','words')),
  parts      int  not null check (parts in (3,4)),
  start      text not null default '' check (length(start) < 2000),
  created_at timestamptz not null default now()
);

create table if not exists turns (
  game_id    text not null references games(id) on delete cascade,
  n          int  not null check (n between 0 and 3),
  strokes    text not null default '' check (length(strokes) < 200000),
  text       text not null default '' check (length(text) <= 70),
  name       text not null default '' check (length(name) <= 24),
  created_at timestamptz not null default now(),
  primary key (game_id, n)
);

create table if not exists wall (
  game_id    text primary key references games(id) on delete cascade,
  created_at timestamptz not null default now()
);

-- Anyone may read and add. Nobody can change or delete through the website.
-- You can still remove anything yourself in the Table Editor.
alter table games enable row level security;
alter table turns enable row level security;
alter table wall  enable row level security;

create policy "read games"  on games for select using (true);
create policy "add games"   on games for insert with check (true);
create policy "read turns"  on turns for select using (true);
create policy "add turns"   on turns for insert with check (n < (select parts from games g where g.id = game_id));
create policy "read wall"   on wall  for select using (true);
create policy "add to wall" on wall  for insert with check ((select count(*) from turns t where t.game_id = wall.game_id) = (select parts from games g where g.id = wall.game_id));
