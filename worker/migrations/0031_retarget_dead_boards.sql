-- Point profiles at the boards companies actually post on now.
--
-- These (ats, slug) pairs all 404 at their ATS (checked 2026-11-09). A dead
-- pair in profile_companies is a dead entry in GET /directives: the scraper
-- auto-disables it and the profile silently gets nothing from that company.
--
--   Default-profile seeds (every profile created until f775d93):
--     lever:anyscale  -> ashby:anyscale       lever:plaid -> ashby:plaid
--     lever:mistral   -> dropped (on none of greenhouse/lever/ashby)
--   Hostname guesses and moved boards (the operator's discovery profile),
--   matched through the scraper's /match on 2026-11-09:
--     greenhouse:withwaymo        -> greenhouse:waymo
--     greenhouse:datadoghq        -> greenhouse:datadog
--     greenhouse:pinterestcareers -> greenhouse:pinterest
--     greenhouse:toasttab         -> greenhouse:toast
--     greenhouse:linkedin         -> lever:linkedin
--     greenhouse:gigaenergy       -> ashby:giga-energy
--     greenhouse:postman, greenhouse:realm, ashby:ocean -> dropped (no board found)
--
-- UPDATE OR IGNORE skips a row whose profile already lists the new pair
-- (UNIQUE(profile_id, ats, slug)); the DELETE then clears that leftover along
-- with the drops, so each profile ends with the live board once.

UPDATE OR IGNORE profile_companies SET ats = 'ashby', slug = 'anyscale' WHERE ats = 'lever' AND slug = 'anyscale';
UPDATE OR IGNORE profile_companies SET ats = 'ashby', slug = 'plaid' WHERE ats = 'lever' AND slug = 'plaid';
UPDATE OR IGNORE profile_companies SET slug = 'waymo' WHERE ats = 'greenhouse' AND slug = 'withwaymo';
UPDATE OR IGNORE profile_companies SET slug = 'datadog' WHERE ats = 'greenhouse' AND slug = 'datadoghq';
UPDATE OR IGNORE profile_companies SET slug = 'pinterest' WHERE ats = 'greenhouse' AND slug = 'pinterestcareers';
UPDATE OR IGNORE profile_companies SET slug = 'toast' WHERE ats = 'greenhouse' AND slug = 'toasttab';
UPDATE OR IGNORE profile_companies SET ats = 'lever' WHERE ats = 'greenhouse' AND slug = 'linkedin';
UPDATE OR IGNORE profile_companies SET ats = 'ashby', slug = 'giga-energy' WHERE ats = 'greenhouse' AND slug = 'gigaenergy';

DELETE FROM profile_companies WHERE (ats, slug) IN (
	VALUES ('lever', 'anyscale'), ('lever', 'plaid'), ('lever', 'mistral'),
	       ('greenhouse', 'withwaymo'), ('greenhouse', 'datadoghq'),
	       ('greenhouse', 'pinterestcareers'), ('greenhouse', 'toasttab'),
	       ('greenhouse', 'linkedin'), ('greenhouse', 'gigaenergy'),
	       ('greenhouse', 'postman'), ('greenhouse', 'realm'), ('ashby', 'ocean')
);
