import { describe, it, expect } from "vitest";
import { sqlExec, containsAll } from "../src/homeserver/verifier.js";
import { PROBES } from "../src/homeserver/probes.js";

// Fixture: top 3 customers by TOTAL SPEND → Bob 300, Carol 200, Alice 150 (Dave 25 is 4th).
const SCHEMA = "CREATE TABLE customers(id INTEGER, name TEXT); CREATE TABLE orders(customer_id INTEGER, amount INTEGER);";
const SEED =
  "INSERT INTO customers VALUES (1,'Alice'),(2,'Bob'),(3,'Carol'),(4,'Dave'); " +
  "INSERT INTO orders VALUES (1,100),(1,50),(2,300),(3,200),(4,25);";
const EXPECTED: Array<Array<string | number>> = [["Bob", 300], ["Carol", 200], ["Alice", 150]];

const v = sqlExec({ schema: SCHEMA, seed: SEED, expected: EXPECTED, orderMatters: true });

const CORRECT =
  "SELECT c.name, SUM(o.amount) FROM customers c JOIN orders o ON c.id=o.customer_id " +
  "GROUP BY c.id ORDER BY SUM(o.amount) DESC LIMIT 3";
// Passes the OLD containsAll keyword check but computes the WRONG thing (COUNT, not SUM).
const WRONG_AGGREGATE =
  "SELECT c.name, COUNT(o.amount) FROM customers c JOIN orders o ON c.id=o.customer_id " +
  "GROUP BY c.id ORDER BY COUNT(o.amount) DESC LIMIT 3";

describe("sqlExec — ground-truth SQL grader (#156)", () => {
  it("PASSES a correct query", async () => {
    expect((await v(CORRECT)).outcome).toBe("pass");
  });

  it("FAILS a wrong-aggregate query that the containsAll keyword check would pass", async () => {
    // the exact #156 inflation: keyword presence says PASS, real execution says FAIL.
    expect(containsAll(["select", "from", "join", "group by", "order by", "limit"], { ci: true })(WRONG_AGGREGATE).outcome).toBe("pass");
    expect((await v(WRONG_AGGREGATE)).outcome).toBe("fail");
  });

  it("compares columns POSITIONALLY — a flipped SELECT (total, name) FAILS (review fix)", async () => {
    const flipped =
      "SELECT SUM(o.amount), c.name FROM customers c JOIN orders o ON c.id=o.customer_id " +
      "GROUP BY c.id ORDER BY SUM(o.amount) DESC LIMIT 3";
    expect((await v(flipped)).outcome).toBe("fail");
  });

  it("does NOT conflate two distinct rows (regression for the per-cell-sort false PASS)", async () => {
    const grader = sqlExec({
      schema: "CREATE TABLE t(a TEXT, b INTEGER);",
      seed: "INSERT INTO t VALUES ('300',400),('400',300);",
      expected: [["300", 400], ["400", 300]],
      orderMatters: true,
    });
    // a wrong query returning two IDENTICAL ('300',400) rows must NOT match the two distinct golds
    expect((await grader("SELECT '300',400 UNION ALL SELECT '300',400")).outcome).toBe("fail");
    expect((await grader("SELECT a, b FROM t")).outcome).toBe("pass");
  });

  it("FAILS when the ordering is wrong (ORDER BY ASC) under orderMatters", async () => {
    const asc = CORRECT.replace("DESC", "ASC");
    expect((await v(asc)).outcome).toBe("fail");
  });

  it("extracts SQL from a fenced code block with surrounding prose", async () => {
    const wrapped = "Here is the query you asked for:\n```sql\n" + CORRECT + ";\n```\nThat returns the top 3.";
    expect((await v(wrapped)).outcome).toBe("pass");
  });

  it("FAILS (does not throw) on a syntax error", async () => {
    const r = await v("SELECT name, SUM( FROM customers");
    expect(r.outcome).toBe("fail");
    expect(r.notes).toMatch(/SQL error/i);
  });

  it("rejects a non-query (DROP) as FAIL, never executing it", async () => {
    expect((await v("DROP TABLE customers")).outcome).toBe("fail");
  });

  it("cannot mutate the fixture — a WITH…DELETE is blocked by query_only, not run", async () => {
    // query_only makes the write throw → FAIL; the fixture is untouched for the next call.
    const attack = "WITH x AS (SELECT 1) DELETE FROM customers";
    expect((await v(attack)).outcome).toBe("fail");
    // proof the table still has its rows: the correct query still passes afterwards.
    expect((await v(CORRECT)).outcome).toBe("pass");
  });

  it("rejects a multi-statement string (prepare() rejects it; the trailing DROP never runs)", async () => {
    const withTrailer = CORRECT + "; DROP TABLE customers";
    expect((await v(withTrailer)).outcome).toBe("fail");
    expect((await v(CORRECT)).outcome).toBe("pass"); // fixture intact — DROP never executed
  });

  it("FAILS a pathological read-only query via a hard timeout instead of hanging the parent process", async () => {
    const timeoutGrader = sqlExec({
      schema: "CREATE TABLE t(x INTEGER);",
      expected: [[1]],
      timeoutMs: 100,
    });
    const r = await timeoutGrader(
      "WITH RECURSIVE cnt(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM cnt) SELECT count(*) FROM cnt"
    );
    expect(r.outcome).toBe("fail");
    expect(r.notes).toMatch(/timeout/i);
  });

  it("does not corrupt a query with a ';' inside a string literal (review fix)", async () => {
    const grader = sqlExec({
      schema: "CREATE TABLE m(name TEXT);",
      seed: "INSERT INTO m VALUES ('a;b'),('c');",
      expected: [["a;b"]],
      orderMatters: true,
    });
    expect((await grader("SELECT name FROM m WHERE name = 'a;b'")).outcome).toBe("pass");
  });

  it("orderMatters:false compares as a set — right rows in any order pass", async () => {
    const unordered = sqlExec({ schema: SCHEMA, seed: SEED, expected: EXPECTED, orderMatters: false });
    const byName =
      "SELECT c.name, SUM(o.amount) FROM customers c JOIN orders o ON c.id=o.customer_id " +
      "GROUP BY c.id ORDER BY SUM(o.amount) DESC LIMIT 3";
    // reorder rows by name (wrong rank order, right rows) — still passes when order doesn't matter
    expect((await unordered(byName.replace("SUM(o.amount) DESC", "c.name"))).outcome).toBe("pass");
  });

  it("throws on an invalid fixture (probe-definition bug surfaces loudly)", async () => {
    const broken = sqlExec({ schema: "CREATE TABLE (;", expected: [["x"]] });
    await expect(Promise.resolve().then(() => broken(CORRECT))).rejects.toThrow(/fixture/i);
  });
});

describe("the sql-top3 probe now grades by execution (#156)", () => {
  const probe = PROBES.find((p) => p.id === "sql-top3");

  it("exists and is wired to the sqlExec verifier", () => {
    expect(probe).toBeDefined();
    expect(probe!.verifierName).toBe("sqlExec");
  });

  it("PASSES a correct answer and FAILS a keyword-rich wrong-aggregate answer", async () => {
    expect((await probe!.verifier(CORRECT)).outcome).toBe("pass");
    expect((await probe!.verifier(WRONG_AGGREGATE)).outcome).toBe("fail");
  });
});
