-- Drop user_companies: legacy since 0007 moved companies onto profiles.
--
-- Nothing has read it since. At the drop it held two rows from 2026-07-24
-- (lever/netflix, ashby/openai), both added by one user before profile slices
-- existed. Its two indexes go with it.
DROP TABLE IF EXISTS user_companies;
