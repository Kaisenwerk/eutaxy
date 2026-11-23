-- Proofs of the delivery model's claims in delivery-model.props.ts, which need induction the Lean
-- engine's tactic script does not do. Each `-- proof:` part proves the statement Eutaxy emits for
-- that property, over the definitions it translates from delivery-model.ts; Lean's kernel checks them.

-- From any attempt the limits still cover, the deliveries are the least of four counts: the run's
-- end, the first handled delivery, and the room each limit leaves from that attempt on.
theorem l_from (h : List Bool) (a l m : Int) (hl : a - 1 ≤ l) (hm : a - 1 ≤ m) :
    f_deliveriesFrom h a l m
      = f_least (Int.ofNat h.length)
          (f_least (f_unhandledFirst h + 1) (f_least (l - a + 2) (m - a + 2))) := by
  induction h generalizing a with
  | nil =>
    have z : Int.ofNat 0 = 0 := rfl
    simp only [f_deliveriesFrom, f_unhandledFirst, f_least, List.length_nil, decide_eq_true_eq, z]
    repeat' split
    all_goals omega
  | cons x xs ih =>
    have hu : 0 ≤ f_unhandledFirst xs := by
      clear ih
      induction xs with
      | nil => simp [f_unhandledFirst]
      | cons y ys ihy => simp only [f_unhandledFirst]; split <;> omega
    cases x with
    | true =>
      simp only [f_deliveriesFrom, f_unhandledFirst, f_least, List.length_cons, decide_eq_true_eq,
        Bool.true_or, ite_true, Int.ofNat_eq_natCast]
      repeat' split
      all_goals omega
    | false =>
      by_cases hr : a - 1 < l ∧ a - 1 < m
      · have e := ih (a + 1) (by omega) (by omega)
        simp only [f_deliveriesFrom, f_redelivers, f_unhandledFirst, List.length_cons, e]
        simp only [f_least, decide_eq_true_eq, Int.ofNat_eq_natCast] at *
        simp [hr.1, hr.2]
        repeat' split
        all_goals omega
      · simp only [f_deliveriesFrom, f_redelivers, f_unhandledFirst, List.length_cons]
        simp only [f_least, decide_eq_true_eq, Int.ofNat_eq_natCast] at *
        have : ¬ (a - 1 < l) ∨ ¬ (a - 1 < m) := by omega
        rcases this with n | n <;> simp [n] <;> (repeat' split) <;> omega

-- From the first attempt, under limits that are not negative, that is the claimed count.
theorem l_exact (h : List Bool) (l m : Int) (hl : 0 ≤ l) (hm : 0 ≤ m) :
    f_deliveries h l m
      = f_least (Int.ofNat h.length) (f_least (f_unhandledFirst h + 1) (f_least (l + 1) (m + 1))) := by
  have e := l_from h 1 l m (by omega) (by omega)
  simp only [f_deliveries, e]
  have a1 : l - 1 + 2 = l + 1 := by omega
  have a2 : m - 1 + 2 = m + 1 := by omega
  rw [a1, a2]

-- proof: withinTheLimits
  intro v_handled v_limit v_maxRedeliveries h
  simp only [Bool.and_true, Bool.and_eq_true, decide_eq_true_eq] at h
  have e := l_exact v_handled v_limit v_maxRedeliveries (by omega) (by omega)
  simp only [f_least, decide_eq_true_eq] at e
  simp only [Bool.and_eq_true, decide_eq_true_eq, e]
  repeat' split
  all_goals omega

-- proof: noneAfterHandled
  intro v_handled v_limit v_maxRedeliveries h
  simp only [Bool.and_true, Bool.and_eq_true, decide_eq_true_eq] at h
  have e := l_exact v_handled v_limit v_maxRedeliveries (by omega) (by omega)
  simp only [f_least, decide_eq_true_eq] at e
  simp only [decide_eq_true_eq, e]
  repeat' split
  all_goals omega

-- proof: exactCount
  intro v_handled v_limit v_maxRedeliveries h
  simp only [Bool.and_true, Bool.and_eq_true, decide_eq_true_eq] at h
  simp only [decide_eq_true_eq]
  exact l_exact v_handled v_limit v_maxRedeliveries (by omega) (by omega)
