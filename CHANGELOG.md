# Changelog

## [0.9.1](https://github.com/Kaisenwerk/eutaxy/compare/v0.9.0...v0.9.1) (2026-10-30)


### Features

* **prover-smt:** a record may be a member of several unions ([facb5c1](https://github.com/Kaisenwerk/eutaxy/commit/facb5c12ba6553beb4a099cc08831a574e5e9e13))
* **prover:** conditional tags in literals, and truthiness of nullable records ([f09ef37](https://github.com/Kaisenwerk/eutaxy/commit/f09ef37345ca7e5590a02a3c06864e88a359ec95))
* **prover:** functions written as arrows that a module-level const holds ([ad8f9a5](https://github.com/Kaisenwerk/eutaxy/commit/ad8f9a5cdc7a959f2b014c291740bd4c7fb135a5))
* **prover:** generic and imported functions, read at each call ([84bc33f](https://github.com/Kaisenwerk/eutaxy/commit/84bc33fc0cdd371c98ec7ea52739e56e1c4370cc))
* **prover:** module constants, Math.floor and division ([be0e79f](https://github.com/Kaisenwerk/eutaxy/commit/be0e79fd4e65381266d4c299b6bf7db736b296a4))


### Bug Fixes

* **cli:** report runs each module in a child process, not a worker thread ([f50051e](https://github.com/Kaisenwerk/eutaxy/commit/f50051e46ea56530d919d49a2cb46ec9397a3d73))
* **prover:** built-ins resolved by the compiler, not by name ([f79392c](https://github.com/Kaisenwerk/eutaxy/commit/f79392c86a1c9c97a6c20318b896bf2c5546cbfc))


### Performance Improvements

* **engine:** one event-loop turn per decision in the concurrent scheduler ([d0e3b1d](https://github.com/Kaisenwerk/eutaxy/commit/d0e3b1db45c042df4472864ebf2d8997f137892b))

## [0.9.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.8.0...v0.9.0) (2026-10-29)


### ⚠ BREAKING CHANGES

* **prover:** `eutaxy` needs `typescript` 7.1 installed in the project (`typescript@7.1.0-beta` until the release): the spec reader runs it. `readSpecs` takes `modulePath` (and `specPath`) instead of `moduleSpecifiers`.

### Features

* **prover:** narrowing by a union's tag, in functions and in claims ([eb3b306](https://github.com/Kaisenwerk/eutaxy/commit/eb3b306d3a899116ac0d927819652fd783cc3e05))
* **prover:** read specs and the subset through the TypeScript 7.1 API ([0c83197](https://github.com/Kaisenwerk/eutaxy/commit/0c831976f19696d856e9a12a3faef1398d111fa7))

## [0.8.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.7.0...v0.8.0) (2026-10-28)


### Features

* **cli:** eutaxy report runs every spec file under a directory ([9e12b43](https://github.com/Kaisenwerk/eutaxy/commit/9e12b43284c32f637ac3bb9816622b9aeb3be14b))
* **core:** the enumeration model, and the enumerator held to it ([f13a3e4](https://github.com/Kaisenwerk/eutaxy/commit/f13a3e41475412557ef968ab3105f16395320457))
* **core:** the enumeration model's claims proven ([5a18b2a](https://github.com/Kaisenwerk/eutaxy/commit/5a18b2a98525f4d88fb93daa26617a8b6fd45381))
* **prover:** arrays in spec binders, drawn and shrunk at TESTED ([644c899](https://github.com/Kaisenwerk/eutaxy/commit/644c8992f22db2b784baeefdb9c15ba9bfa2ad37))
* **prover:** lists and structural recursion in the subset, translated by Lean ([b216915](https://github.com/Kaisenwerk/eutaxy/commit/b21691567587052f19d6058e190c4256196f34ae))
* **prover:** proofs supplied beside the spec file, checked by the kernel ([345822a](https://github.com/Kaisenwerk/eutaxy/commit/345822a3788d8952142775ca79db60d3c5e1876d))
* **prover:** TESTED tries every edge value before any random draw ([26b8f6c](https://github.com/Kaisenwerk/eutaxy/commit/26b8f6c72890a39335fece08a77af7b8ff739c40))
* **prover:** the ladder can start at TESTED when no scenario ran ([d3604dc](https://github.com/Kaisenwerk/eutaxy/commit/d3604dcf12265d42de3a4999f698bf26fbe4c623))
* **report:** a spec report by module, as text and as JSON ([6e6f1a7](https://github.com/Kaisenwerk/eutaxy/commit/6e6f1a7a5672b9a3b23dd2f76d7f6e67e6ed97b9))
* **spec:** sample, which limits the inputs TESTED draws but not the claim ([dad262a](https://github.com/Kaisenwerk/eutaxy/commit/dad262a8f4610b71153446b90a88e3690bc8c02c))


### Bug Fixes

* **cli:** a value flag given without a value is an error ([46ae049](https://github.com/Kaisenwerk/eutaxy/commit/46ae04982c3262d06755d68d13244a9f621c0580))


### Documentation

* **roadmap:** v0.8 done, v0.9 the reader on the TypeScript 7.1 API ([b67be7e](https://github.com/Kaisenwerk/eutaxy/commit/b67be7ebebdeb32c4e42b98f7f772d61650a1628))

## [0.7.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.6.0...v0.7.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **spec:** Lemma annotations in JSDoc are no longer read. Move each module's `@ensures{name} forall (x: int) { … }` into a spec file beside it, `<module>.props.ts`, as `export const name = forall(f, { when, ensures })`: the binders are `f`'s parameters, a root implication becomes `when`, a `nat` or interval guard becomes a comparison in `when` (with `Number.isInteger(n)` where the claim is about integers, since `number` is the double type), a regex guard becomes `/re/.test(s)` in `when`, `∧ ∨ ¬ ↔ ≡` become `&& || ! ===`, and `@total` becomes `export const fTotal = total(f)`. `@throws` has no replacement. The property's name is its export name, so `eutaxy check` reports `withinCaptured` where it reported `within-captured`. `eutaxy` no longer exports `parseProperty`, `printProperty`, `extractSpecs`, `LemmaSyntaxError` or the `Formula`, `Domain` and `Guard` types; `eutaxy/spec` exports `forall`, `total` and `isSpec`. A `Prover` now takes the module's `specs` beside its source.

### Features

* **prover-smt:** the SMT engine over Z3, doubles and code-unit strings, models replayed ([fb7e5a0](https://github.com/Kaisenwerk/eutaxy/commit/fb7e5a0514379bd243ead01d3a85b74df10c397c))
* **prover:** nullable types and tagged unions in the subset, proved by the SMT engine ([0ba068f](https://github.com/Kaisenwerk/eutaxy/commit/0ba068f5a0d8aea6c03f153e488a00494d0573e0))
* **spec:** specs in TypeScript, in a spec file beside the module ([ec8553a](https://github.com/Kaisenwerk/eutaxy/commit/ec8553af4e78f98c340061dc696782e26414ed41))

## [0.6.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.5.1...v0.6.0) (2026-10-26)


### ⚠ BREAKING CHANGES

* **eutaxy:** `checkSpecModule`, `lemmaBool`, `lemmaUnresolved` and `ModulePredicates` are no longer exported from `eutaxy`; a test that imported them to check specs by hand uses `eutaxy check`, or `checkedRung`, `testedRung` and `specLadder`, instead. `QueueHandler` is no longer exported from `eutaxy/cloudflare`; write `WorkerHandler`.

### Features

* **core:** PROVEN and CONFLICT spec verdicts ([f3d6a24](https://github.com/Kaisenwerk/eutaxy/commit/f3d6a248a32730479f45ee8a8846bf00264bdeeb))
* **core:** TESTED spec verdict and generated counterexamples ([e0e2834](https://github.com/Kaisenwerk/eutaxy/commit/e0e283484e848f6e730b8260fcf0a3fa04ee40cb))
* **eutaxy:** close v0.6: the exports deprecated through 0.5.x leave the facade ([86a253b](https://github.com/Kaisenwerk/eutaxy/commit/86a253bda5aa95ff35ce97d72cff95e517a1b5cd))
* **prover-lean:** first-party engine on the initial subset, checked by Lean 4.35.0 ([403b1dd](https://github.com/Kaisenwerk/eutaxy/commit/403b1dd98d75d395b68aa4a1ecf20503e278894a))
* **prover-lean:** strings in the subset ([3a45175](https://github.com/Kaisenwerk/eutaxy/commit/3a45175ba7c60ee333c5e3b267278889639705b8))
* **prover:** Prover interface, PROVEN rung in eutaxy check, aggregation ([4fcb42c](https://github.com/Kaisenwerk/eutaxy/commit/4fcb42ca1f55f3df289f04d1721fe5ce4c248e17))
* **prover:** TESTED rung and the ladder from CHECKED to TESTED ([5b335ad](https://github.com/Kaisenwerk/eutaxy/commit/5b335ad480f9efb2606ea1ab98306c232f7ef1b6))
* **spec:** export the tokenizer for engines that read annotated modules ([2524fcb](https://github.com/Kaisenwerk/eutaxy/commit/2524fcb9cc7ed320657aa46cfb0daebf18cf5ec0))


### Bug Fixes

* **eutaxy:** show the repository README and keywords on the npm page ([a200238](https://github.com/Kaisenwerk/eutaxy/commit/a200238fea00fddfe7b5fa6af95693ffd5d6620f))

## [0.5.1](https://github.com/Kaisenwerk/eutaxy/compare/v0.5.0...v0.5.1) (2026-10-25)


### Features

* **cli:** --budget-ms replaces the scenario's time budget ([6455130](https://github.com/Kaisenwerk/eutaxy/commit/6455130d913d1577e30a7335d52fc7db94ae822b))
* **cli:** eutaxy check and regression tests run Workflow scenarios ([6756ecc](https://github.com/Kaisenwerk/eutaxy/commit/6756ecceada593de20079c6768ca886b691d77f2))
* **cloudflare:** deprecate QueueHandler, the former name of WorkerHandler ([5441c57](https://github.com/Kaisenwerk/eutaxy/commit/5441c574222b6a4b054cdea3ae5980983942cf55))
* **cloudflare:** model R2 buckets ([886317b](https://github.com/Kaisenwerk/eutaxy/commit/886317b99e712594f7829b585216fbe8cbb1a438))
* **cloudflare:** Workflows as a model of the engine ([51805a8](https://github.com/Kaisenwerk/eutaxy/commit/51805a82cbf9cec95f276dd5b7863a44efdcd072))
* **core:** references invariant for rows another snapshot must name ([38d66b9](https://github.com/Kaisenwerk/eutaxy/commit/38d66b9b854f3a1d12094fed802a4b99779deb15))
* **engine:** seeded runs place faults by position, not by a chance at each point ([875590f](https://github.com/Kaisenwerk/eutaxy/commit/875590ffd57a1bae03b317866ee802565515e25b))
* **eutaxy:** deprecate checkSpecModule, lemmaBool and lemmaUnresolved ([56a4ef2](https://github.com/Kaisenwerk/eutaxy/commit/56a4ef2d8ea63d9b211f5352db69e43959857947))


### Bug Fixes

* **core:** one toJson summarizes every payload, in any time zone ([c498418](https://github.com/Kaisenwerk/eutaxy/commit/c4984182df64158d3509e421f67f78b1ff54a947))
* **engine:** a real deadline past the host's timer limit waits ([69d851f](https://github.com/Kaisenwerk/eutaxy/commit/69d851f30c6788bf5967de435411d9278fd006d7))
* **engine:** count the run that turns the reduction off as a schedule ([61c7439](https://github.com/Kaisenwerk/eutaxy/commit/61c743923794880d3433a1f3573f6fcf8af5198b))
* **report:** print the Exhaustive line on every exhaustive verdict ([e58248d](https://github.com/Kaisenwerk/eutaxy/commit/e58248d388df44134b76bf47b9ec67114c76daec))

## [0.5.0](https://github.com/Kaisenwerk/eutaxy/compare/v0.4.0...v0.5.0) (2026-10-24)


### Features

* **cli:** check --exhaustive and the exhaustive verdict line ([0bef255](https://github.com/Kaisenwerk/eutaxy/commit/0bef25594592820c7015ef989624aceabd217215))
* **cli:** check a scenario's specs ([728c9e1](https://github.com/Kaisenwerk/eutaxy/commit/728c9e19d68636f9fe0f12e5b23e9384df0794d3))
* **cloudflare:** caller retry delays and response deadline on the http drive ([0cf77fe](https://github.com/Kaisenwerk/eutaxy/commit/0cf77fedd56650216cbc2087cbd4e7d75f6d40de))
* **cloudflare:** Durable Object alarms in virtual time ([7802486](https://github.com/Kaisenwerk/eutaxy/commit/78024866c3ce88e0bdeca42684abee0157cf7c3b))
* **cloudflare:** Durable Objects behind a proxied stub boundary ([81cd7aa](https://github.com/Kaisenwerk/eutaxy/commit/81cd7aa3168b0804898ae6b23b76b96013c5417d))
* **cloudflare:** interleave calls into an object at its outbound I/O ([c542f89](https://github.com/Kaisenwerk/eutaxy/commit/c542f893af51b76f05544eba457b02c428a7403f))
* **cloudflare:** refines and d1Read helpers, specs in scenarios ([9299c2b](https://github.com/Kaisenwerk/eutaxy/commit/9299c2b90189661fad02d2d3ebbc72038f964ef5))
* **core:** refines, spec verdicts and scenario specs ([d51308d](https://github.com/Kaisenwerk/eutaxy/commit/d51308dd40215be9d0c67f0144c10e21e299222a))
* **core:** unique state invariant ([c0aa034](https://github.com/Kaisenwerk/eutaxy/commit/c0aa0347045efbabe298410d2b3899ab1cb42ade))
* **engine:** abandon hooks for effects and safer nesting ([f87e4f5](https://github.com/Kaisenwerk/eutaxy/commit/f87e4f5be16dd3be9da851074d558edb0a21e65d))
* **engine:** delayed events, mid-delivery enqueue, bookkeeping invocations ([31d47de](https://github.com/Kaisenwerk/eutaxy/commit/31d47dea2ce0833fd1e59eea1d66785186b230ac))
* **engine:** exhaustive exploration with partial-order reduction ([d6f253d](https://github.com/Kaisenwerk/eutaxy/commit/d6f253d75e34e09dd38d7118dd330382845bffa3))
* **engine:** nested effects and a network guard for platform work ([02beed8](https://github.com/Kaisenwerk/eutaxy/commit/02beed85e061bf445cddf252f76226e9527298a7))
* **engine:** observe core functions as decisions ([ecade52](https://github.com/Kaisenwerk/eutaxy/commit/ecade52523be5927cb6f7a60709e5b671cc2c3e0))
* **engine:** run concurrent invocations interleaved at effects ([af52a95](https://github.com/Kaisenwerk/eutaxy/commit/af52a95889612a032181512dcd0289ba4fdb739f))
* **engine:** turns at hosted code's own effects ([3e40206](https://github.com/Kaisenwerk/eutaxy/commit/3e40206425b2eac38b36bdc2a5ba3505edb52824))
* **prover:** the CHECKED rung ([08daf65](https://github.com/Kaisenwerk/eutaxy/commit/08daf655d7a37cd2a306288e131ef957903251e4))
* **report:** spec verdicts, and replays that observe the core ([d8b8a9b](https://github.com/Kaisenwerk/eutaxy/commit/d8b8a9be47e0d47185b084f53bea51ff608e8307))
* **spec:** SpecIR and a Lemma parser, printer and predicate compiler ([cb8d4fc](https://github.com/Kaisenwerk/eutaxy/commit/cb8d4fc1171a0da2ef9daefbc64416c981a5a4e5))


### Bug Fixes

* **cli:** the help's exit codes include a refuted spec ([5fa4080](https://github.com/Kaisenwerk/eutaxy/commit/5fa408066a3dc5576080f7a58a4601b85d2fa430))
* **cloudflare:** say what a concurrent run explores inside a Durable Object ([e3fb511](https://github.com/Kaisenwerk/eutaxy/commit/e3fb511db622335e23ea6061a5eb2008c520aeb9))
* **engine:** end hung effects, wait for Web Crypto, wake turns on progress ([387b6f6](https://github.com/Kaisenwerk/eutaxy/commit/387b6f62b639a4187c178c1fe3f285ac1e87e7cd))


### Miscellaneous Chores

* release 0.5.0 ([c14ff2c](https://github.com/Kaisenwerk/eutaxy/commit/c14ff2cef91aa2f9ee5c639182e1992f361b77a1))

## 0.4.0 (2026-10-23)


### Features

* initial release ([2ee7747](https://github.com/Kaisenwerk/eutaxy/commit/2ee77470b9a1171a582ffa96a1ef6b6bc48a9aa3))
