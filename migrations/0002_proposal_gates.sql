-- Proposals a reviewer is offered only once a condition holds (task type page_review). NULL: always open.
--   'reserve'       a replacement page: open once a rejected page of the batch is assigned to it (the queue assigns
--                   rejected pages, in rank order, to the first unused reserve of the same category, else the next).
--   'after_confirm' a blind second pass: open to a reviewer once their own current decision on the paired proposal
--                   (gate_ref = its external_id, same batch) is a confirm and their first decision on it is at least
--                   24 hours old.
ALTER TABLE proposals ADD COLUMN gate_kind TEXT CHECK (gate_kind IS NULL OR gate_kind IN ('reserve', 'after_confirm'));
ALTER TABLE proposals ADD COLUMN gate_ref TEXT;
