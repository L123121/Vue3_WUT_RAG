ALTER TABLE agent_runs ADD COLUMN generation TEXT NOT NULL DEFAULT '';
ALTER TABLE agent_runs ADD COLUMN lease_token TEXT NOT NULL DEFAULT '';
UPDATE agent_runs SET generation = 'legacy:' || id WHERE generation = '';
