-- In-thread replies (M7 batch 4): the References chain is kept with the draft so an edit (drafts PUT) keeps the thread headers.
ALTER TABLE drafts ADD COLUMN refs TEXT;
