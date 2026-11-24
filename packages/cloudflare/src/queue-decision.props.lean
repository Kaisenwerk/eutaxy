-- Proofs of the claims of the queue's decision rule in queue-decision.props.ts that need induction
-- the Lean engine's tactic script does not do. Each `-- proof:` part proves the statement Eutaxy
-- emits for that property, over the definitions it translates from queue-decision.ts; Lean's kernel
-- checks them.

-- Once a decision stands, no list of later calls replaces it.
theorem l_stands (s : String) (calls : List String) (hs : s ≠ "none") :
    f_standingAfter s calls = s := by
  induction calls with
  | nil => simp [f_standingAfter]
  | cons c cs ih => simp [f_standingAfter, f_standsAfter, hs, ih]

-- So from none standing, the decision after a list of calls is its first.
theorem l_first (c : String) (cs : List String) (hc : c ≠ "none") :
    f_standingAfter "none" (c :: cs) = c := by
  simp [f_standingAfter, f_standsAfter, l_stands c cs hc]

-- A call a handler can make is an acknowledgement or a retry, never "none".
theorem l_decision (c : String) (cs : List String) (h : f_decisions (c :: cs) = true) :
    c ≠ "none" := by
  simp only [f_decisions, List.all_cons, Bool.and_eq_true, Bool.or_eq_true, decide_eq_true_eq] at h
  rcases h.1 with e | e <;> simp [e]

-- proof: firstDecisionWins
  intro v_calls v_completed h
  simp only [Bool.and_eq_true, decide_eq_true_eq] at h
  cases v_calls with
  | nil => simp at h
  | cons c cs =>
    have hc := l_decision c cs h.2
    simp [f_settled, l_first c cs hc, f_acknowledgedImplicitly, hc]

-- proof: handledExactly
  intro v_calls v_completed h
  cases v_calls with
  | nil =>
    cases v_completed <;>
      simp [f_settled, f_standingAfter, f_acknowledgedImplicitly, f_standsAfter, f_handled]
  | cons c cs =>
    have hc := l_decision c cs h
    simp [f_settled, l_first c cs hc, f_acknowledgedImplicitly, hc, f_handled]
    exact Or.inl (by omega)

-- proof: onlyTheFirstTakesEffect
  intro v_standing v_calls h
  simp only [Bool.and_eq_true, decide_eq_true_eq] at h
  cases v_calls with
  | nil => simp [f_standingAfter, f_takesEffect, h.1]
  | cons c cs =>
    have hc := l_decision c cs h.2
    simp [h.1, l_first c cs hc, f_takesEffect, hc]
    omega
