-- Assign random avatars to agents that don't have one
UPDATE agents SET avatar = 'avatar-21' WHERE name = 'Desktop' AND avatar IS NULL;
UPDATE agents SET avatar = 'avatar-20' WHERE name = 'letterkenny' AND avatar IS NULL;
UPDATE agents SET avatar = 'avatar-02' WHERE name = 'Lorri' AND avatar IS NULL;
UPDATE agents SET avatar = 'avatar-17' WHERE name = 'Ronny' AND avatar IS NULL;
UPDATE agents SET avatar = 'avatar-03' WHERE name = 'trust' AND avatar IS NULL;
UPDATE agents SET avatar = 'avatar-09' WHERE name = 'ww0' AND avatar IS NULL;
