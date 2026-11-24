-- The proof of the supersession claim in alarm-rules.props.ts, which needs induction the Lean
-- engine's tactic script does not do. The `-- proof:` part proves the statement Eutaxy emits for
-- that property, over the definitions it translates from alarm-rules.ts; Lean's kernel checks it.

-- Every change starts the next generation, so after a list of changes the generation has grown by
-- the list's length.
theorem l_after (g : Int) (changes : List Bool) :
    f_generationAfter g changes = g + Int.ofNat changes.length := by
  induction changes generalizing g with
  | nil => simp [f_generationAfter]
  | cons c cs ih =>
    simp only [f_generationAfter, f_nextGeneration, ih, List.length_cons, Int.ofNat_eq_natCast]
    omega

-- proof: supersededByAnyChange
  intro v_generation v_changes h
  simp only [f_superseded, l_after, decide_eq_decide, Int.ofNat_eq_natCast, decide_eq_true_eq]
  omega
