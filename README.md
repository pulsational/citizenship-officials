# citizenship-officials

Every day this repository fetches the current U.S. officials that some civics test answers depend on: members of the House (including vacant seats), senators, governors, state capitals, and the national officeholders. It validates the data and publishes one file:

**https://pulsational.github.io/citizenship-officials/officials.json**

That is the only file on the site. A citizenship-test study app reads it at startup. If the file can't be fetched, is malformed, or is older than the copy bundled in the app, the app uses its own copy instead.

每天抓一次「会随选举变的答案」（众议员和空缺席位、参议员、州长、首府、全国类），校验通过后提交回本仓库的 `public/officials.json`，再用 GitHub Pages 只发布这一个文件。

## Sources

All of these are public official pages. They are fetched one at a time, one second apart, with the fixed User-Agent `shortvideo-skill/1.0`. Any 403, 429 or other non-200 response fails the whole run. There are no retries with different headers and no fallback to another site.

| Data | Source |
|---|---|
| House members, party, vacant seats (footnote text) | https://clerk.house.gov/xml/lists/MemberData.xml |
| Senators, party, bioguideId | https://www.senate.gov/general/contact_information/senators_cfm.xml |
| Governor name, governor's office city (checked against the capital) | https://www.usa.gov/states/&lt;state&gt; (50 pages) |
| Governor party, cross-check of governor name | https://www.nga.org/governors/&lt;state&gt;/ (50 pages) |
| National officeholders (President, Speaker …) | `src/data/bank.json`, the `current_answers` from the USCIS civics test updates page (not fetched) |

## Validation (any failure stops the run, so nothing is committed or published)

- Exactly 50 states, 2 senators each, 50 governors, a capital for every state.
- House: members plus vacancies equal 435, and the seats are exactly the 435 districts in `src/data/zctaDistricts.json`.
- Required fields are present: name, accepted answers, party, and bioguideId for members of Congress.
- The two sources must agree: usa.gov and nga.org name the same governor, and the governor's office city matches the capital.
- `dataVersion` never goes backwards. It increases by 1 only when people or parties change.
- If more than 20 seats change at once, the run stops for a human to check. On the day a new Congress starts, run it manually with `allow_big_change`.
- Finally, the app's own `parseOfficials` (`src/officials/index.ts`) must accept the file.

## Run locally

```sh
node -v                     # 24.22.2 (.nvmrc)
npm test                    # offline, uses the saved pages in scripts/officials/src
node pipeline/officials/run.ts --out out --prev public/officials.json --no-photos
```

## Files

- `.github/workflows/officials-daily.yml`: the daily job. It runs at 14:00 UTC and can also be started by hand. It uses only this repository's own `GITHUB_TOKEN`; there are no other secrets.
- `pipeline/officials/`: fetch, build, validate and write the output.
- `scripts/officials/build.ts`: parses the source pages. `scripts/officials/src/` holds saved copies of the source pages, used by the tests.
- `src/officials/`: the data format and validator, shared with the app.
- `src/data/zctaDistricts.json`: the 435 congressional districts, from the 119th Congress Census relationship file. It has to be replaced when the 120th Congress starts on 2027-01-03.
- `public/officials.json`: the published file.

Photos of officials are not fetched or published here.
