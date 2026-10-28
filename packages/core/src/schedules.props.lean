-- Proofs of the enumeration model's claims in schedules.props.ts, which need induction the Lean
-- engine's tactic script does not do. Each `-- proof:` part proves the statement Eutaxy emits for
-- that property, over the definitions it translates from schedules.ts; Lean's kernel checks them.

-- scheduleCount's fold, from any accumulator: that accumulator times the product of the rest.
theorem l_foldl (l : List (List String)) (a : Int) :
    List.foldl (fun v_n v_options => v_n * Int.ofNat (List.length v_options)) a l
      = a * List.foldl (fun v_n v_options => v_n * Int.ofNat (List.length v_options)) 1 l := by
  induction l generalizing a with
  | nil => simp
  | cons h t ih =>
    simp only [List.foldl]
    rw [ih (a * _), ih (1 * _), Int.one_mul, Int.mul_assoc]

-- One more level multiplies the schedules by how many options it offers.
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

-- same is equality, contains membership, noRepeats Lean's Nodup.
theorem l_same (a b : List Int) : f_same a b = true ↔ a = b := by
  induction a generalizing b with
  | nil => cases b <;> simp [f_same] <;> omega
  | cons x xs ih =>
    cases b with
    | nil => simp [f_same]
    | cons y ys => simp [f_same, ih]

theorem l_contains (all : List (List Int)) (s : List Int) : f_contains all s = true ↔ s ∈ all := by
  induction all with
  | nil => simp [f_contains]
  | cons h t ih =>
    simp only [f_contains, Bool.or_eq_true, l_same, ih, List.mem_cons]
    exact ⟨fun e => e.elim (fun q => Or.inl q.symm) Or.inr, fun e => e.elim (fun q => Or.inl q.symm) Or.inr⟩

theorem l_noRepeats (all : List (List Int)) : f_noRepeats all = true ↔ all.Nodup := by
  induction all with
  | nil => simp [f_noRepeats]
  | cons h t ih => simp [f_noRepeats, ih, List.nodup_cons, ← l_contains]

-- zipIdx numbers a level's options in increasing order.
theorem l_zipIdx_lt (h : List String) (k : Nat) :
    List.Pairwise (fun a b => a.2 < b.2) (h.zipIdx k) := by
  induction h generalizing k with
  | nil => simp
  | cons x xs ih =>
    simp only [List.zipIdx_cons, List.pairwise_cons]
    refine ⟨?_, ih (k + 1)⟩
    intro ⟨y, i⟩ hp
    have := (List.mem_zipIdx hp).1
    simp only
    omega

-- Schedules under different options of the first level differ there; under one option they differ
-- below, by induction.
theorem l_nodup (levels : List (List String)) : (f_schedules levels).Nodup := by
  induction levels with
  | nil => simp [f_schedules]
  | cons h t ih =>
    simp only [f_schedules]
    rw [List.nodup_iff_pairwise_ne, List.pairwise_flatMap]
    constructor
    · intro ⟨y, i⟩ _
      rw [List.pairwise_map]
      exact (List.nodup_iff_pairwise_ne.mp ih).imp (fun hne heq => hne (List.cons.inj heq).2)
    · apply (l_zipIdx_lt h 0).imp
      intro ⟨y1, i1⟩ ⟨y2, i2⟩ hlt x hx z hz
      simp only [List.mem_map] at hx hz
      obtain ⟨s1, _, rfl⟩ := hx
      obtain ⟨s2, _, rfl⟩ := hz
      intro heq
      simp at heq hlt
      omega

theorem l_within (levels : List (List String)) :
    ∀ s ∈ f_schedules levels, f_withinLevels s levels = true := by
  induction levels with
  | nil =>
    intro s hs
    simp [f_schedules] at hs
    subst hs
    simp [f_withinLevels]
  | cons h t ih =>
    intro s hs
    simp only [f_schedules, List.mem_flatMap, List.mem_map] at hs
    obtain ⟨⟨y, i⟩, hi, s', hs', rfl⟩ := hs
    have := List.mem_zipIdx hi
    simp [f_withinLevels, ih s' hs']
    omega

-- proof: countIsProduct
  intro v_levels
  simp only [decide_eq_true_eq]
  exact l_count v_levels

-- proof: noRepeat
  intro v_levels
  rw [l_noRepeats]
  exact l_nodup v_levels

-- proof: inBounds
  intro v_levels
  simp only [List.all_eq_true]
  exact l_within v_levels
