-- Interaction log (M7 batch 5): button taps (undo, cancel) and voice events update the row they belong to by its
-- proposal/undo id, and /log and the web Log page filter by route; the columns already exist (0029).
CREATE INDEX IF NOT EXISTS interactions_proposal ON interactions(proposal_id);
CREATE INDEX IF NOT EXISTS interactions_undo ON interactions(undo_id);
CREATE INDEX IF NOT EXISTS interactions_route ON interactions(route,created_at);
