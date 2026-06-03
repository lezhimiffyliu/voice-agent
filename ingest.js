// Data ingestion for the problem bank.
//
// Reads the raw UW exam JSON files in data/exams/ (each file is a list of
// problems, each problem has a `stem` and one or more `parts`) and writes a
// single list of tutorable PROBLEMS to data/problems.json.
//
// One output item = one whole exam problem, keeping all of its parts (a, b, c…)
// together so a multi-part question shows up as a single problem, not several
// disconnected fragments. Parts that require a diagram (no image for Claire to
// "see" over voice) are dropped; a problem is kept as long as it has at least
// one usable part left.
//
// Run:  npm run ingest   (or: node ingest.js [sourceDir])

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SRC_DIR = process.argv[2] || process.env.PROBLEMS_DIR || path.join(__dirname, 'data', 'exams');
const OUT_FILE = path.join(__dirname, 'data', 'problems.json');

// "math_124" -> "Math 124"
function prettyCourse(course) {
  const m = /^([a-z]+)_?(\d+)$/i.exec(course || '');
  if (!m) return course || 'Unknown';
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}`;
}

// "au24_final" -> "Au24 Final"
function prettyExam(exam) {
  return (exam || '')
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
    .trim();
}

// "taylor_polynomials_and_series" -> "Taylor Polynomials And Series"
function prettyTopic(topic) {
  return (topic || 'other')
    .split('_')
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function main() {
  if (!fs.existsSync(SRC_DIR)) {
    console.error(`Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }

  const files = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.json'));
  const items = [];
  let skippedDiagramParts = 0;
  let skippedAllDiagramProblems = 0;
  let totalParts = 0;

  for (const file of files) {
    const raw = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
    let problems;
    try {
      problems = JSON.parse(raw);
    } catch (err) {
      console.warn(`Skipping ${file}: invalid JSON (${err.message})`);
      continue;
    }
    if (!Array.isArray(problems)) continue;

    for (const p of problems) {
      const rawParts = Array.isArray(p.parts) ? p.parts : [];

      // Keep every part that has question text and does not depend on a diagram.
      const parts = [];
      for (const part of rawParts) {
        if (!part.question_text) continue;
        if (part.has_diagram) {
          skippedDiagramParts++;
          continue;
        }
        parts.push({
          label: part.label ? String(part.label) : '',
          question: part.question_text,
          answer: part.final_answer || '',
        });
      }

      // Drop a problem only if nothing tutorable survives.
      if (parts.length === 0) {
        skippedAllDiagramProblems++;
        continue;
      }
      totalParts += parts.length;

      items.push({
        id: p.id,
        courseKey: p.course || 'unknown',
        course: prettyCourse(p.course),
        exam: prettyExam(p.exam),
        topicKey: p.topic || 'other',
        topic: prettyTopic(p.topic),
        concepts: Array.isArray(p.concepts) ? p.concepts : [],
        points: p.points ?? null,
        problemNumber: p.problem_number ?? null,
        // Shared context/instructions for the whole problem; may be empty.
        stem: p.stem || '',
        // All parts of this problem, kept together.
        parts,
      });
    }
  }

  // Stable sort: course, then exam, then problem number.
  items.sort((a, b) => {
    return (
      a.courseKey.localeCompare(b.courseKey) ||
      a.exam.localeCompare(b.exam) ||
      (a.problemNumber || 0) - (b.problemNumber || 0)
    );
  });

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(items, null, 0));

  const topics = new Set(items.map((i) => i.topic));
  const courses = new Set(items.map((i) => i.course));
  console.log(`Ingested ${files.length} exam files.`);
  console.log(`  ${items.length} problems (${totalParts} parts) written to ${path.relative(__dirname, OUT_FILE)}`);
  console.log(`  ${courses.size} courses, ${topics.size} topics`);
  console.log(`  skipped: ${skippedDiagramParts} diagram parts, ${skippedAllDiagramProblems} all-diagram problems`);
}

main();
