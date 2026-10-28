-- Proofs the Lean engine's tactic script does not find, for claims in domain.props.ts. Each
-- `-- proof:` part proves the statement Eutaxy emits for that property; Lean's kernel checks it.

-- The fold scheduleCount compiles to starts from any accumulator: the product of the rest, times it.
theorem l_foldl (l : List (List String)) (a : Int) :
    List.foldl (fun v_n v_options => v_n * Int.ofNat (List.length v_options)) a l
      = a * List.foldl (fun v_n v_options => v_n * Int.ofNat (List.length v_options)) 1 l := by
  induction l generalizing a with
  | nil => simp
  | cons h t ih =>
    simp only [List.foldl]
    rw [ih (a * _), ih (1 * _), Int.one_mul, Int.mul_assoc]

-- One more level multiplies the schedules by its options.
theorem l_length (h : List String) (t : List (List String)) :
    (f_schedules (h :: t)).length = h.length * (f_schedules t).length := by
  simp only [f_schedules, List.length_flatMap, List.length_map]
  have : ∀ (l : List (String × Nat)) (c : Nat), (List.map (fun _ => c) l).sum = l.length * c := by
    intro l c
    induction l with
    | nil => simp
    | cons x xs ih => simp [ih, Nat.succ_mul, Nat.add_comm]
  rw [this, List.length_zipIdx]

theorem l_count (levels : List (List String)) :
    Int.ofNat (f_schedules levels).length = f_scheduleCount levels := by
  induction levels with
  | nil => simp [f_schedules, f_scheduleCount]
  | cons h t ih =>
    rw [l_length]
    simp only [f_scheduleCount, List.foldl] at *
    rw [l_foldl, ← ih]
    simp [Int.mul_comm]

-- proof: countIsProduct
  intro v_levels
  simp only [decide_eq_true_eq]
  exact l_count v_levels

-- proof: sumOfOne
  intro v_xs h
  cases v_xs with
  | nil => simp at h
  | cons a t =>
    cases t with
    | nil => simp [f_sum]
    | cons b u => simp at h; omega
