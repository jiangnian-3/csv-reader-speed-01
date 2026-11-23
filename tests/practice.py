#!/usr/bin/env python3
import hashlib
import json
import os
import resource
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parents[1]
KIT = PROJECT.parent / 'csv-reader-speed-01-run-20261121-kit'
V3 = PROJECT / 'repo-v3'
NODE = shutil.which('node') or '/usr/bin/node'
EXPECTED = 'bb5b6cc5c523edf0b18a20cd1f577b0d461b3ae021fd3ab2c9b4e4a5f01002ed'


def digest(path):
    h = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def main_run(bot, input_dir, output_dir):
    output_dir.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, MAKEFUN_INPUT_DIR=str(input_dir), MAKEFUN_OUTPUT_DIR=str(output_dir))
    proc = subprocess.run([NODE, str(bot / 'main.ts')], env=env, capture_output=True, text=True)
    if proc.returncode:
        raise RuntimeError(f'{bot} exited {proc.returncode}: {proc.stderr[-2000:]}')
    answer = output_dir / 'answers.json'
    return {'sha256': digest(answer), 'bytes': answer.stat().st_size, 'path': str(answer)}


def local_grade(label, save):
    save.mkdir(parents=True, exist_ok=True)
    args = [
        NODE, str(KIT / 'cli/makefun.mjs'), 'grade-local', '--kit', str(KIT),
        '--bot', str(ROOT), '--worktree', '--driver', 'process', '--save', str(save),
    ]
    proc = subprocess.run(args, cwd=PROJECT, capture_output=True, text=True)
    (save / 'stdout.txt').write_text(proc.stdout)
    (save / 'stderr.txt').write_text(proc.stderr)
    if proc.returncode:
        raise RuntimeError(f'{label} grade-local exited {proc.returncode}: {proc.stderr[-3000:]}')
    scores_path = save / 'scores.json'
    scores = json.loads(scores_path.read_text())
    assert scores == {'cases_passed': 6, 'cases_total': 6, 'passed': 1}, (label, scores)
    summary = json.loads((save / 'summary.json').read_text())
    return {'label': label, 'scores': scores, 'scores_sha256': digest(scores_path),
            'status': summary['status'], 'l1': summary.get('l1')}


def check(root_out):
    root_out.mkdir(parents=True, exist_ok=True)
    practice = KIT / 'practice/input'
    v3_first = main_run(V3, practice, root_out / 'v3-1')
    v3_second = main_run(V3, practice, root_out / 'v3-2')
    new_first = main_run(ROOT, practice, root_out / 'wasm-1')
    new_second = main_run(ROOT, practice, root_out / 'wasm-2')
    assert v3_first['sha256'] == v3_second['sha256'], 'v3 repeated-run mismatch'
    assert v3_first['sha256'] == EXPECTED, ('v3 did not reproduce L1', v3_first)
    assert new_first['sha256'] == new_second['sha256'], 'WASM repeated-run mismatch'
    assert new_first['sha256'] == EXPECTED, ('WASM bytes differ from L1', new_first)
    assert new_first['sha256'] == v3_first['sha256'], 'WASM bytes differ from v3'

    test_cmd = [NODE, str(ROOT / 'tests/differential.mjs'), 'edges', str(KIT)]
    edge = subprocess.run(test_cmd, cwd=ROOT, capture_output=True, text=True)
    if edge.returncode:
        raise RuntimeError(edge.stdout + edge.stderr)
    fuzzes = [None] * 3

    def fuzz(shard):
        proc = subprocess.run([NODE, str(ROOT / 'tests/differential.mjs'), 'fuzz', str(KIT), str(shard)],
                              cwd=ROOT, capture_output=True, text=True)
        if proc.returncode:
            raise RuntimeError(proc.stdout + proc.stderr)
        return proc.stdout.strip()

    grade = local_grade('serial', root_out / 'kit-grade-serial')
    # Independent CPU-bound differential shards run concurrently on isolated inputs/output.
    with ThreadPoolExecutor(max_workers=3) as pool:
        fuzzes = list(pool.map(fuzz, range(3)))
    # Program/v1's single-entry trial has no concurrency option; these independent
    # trial processes run together to test isolated parallel grade equivalence.
    with ThreadPoolExecutor(max_workers=2) as pool:
        parallel = list(pool.map(lambda i: local_grade(f'parallel-{i}', root_out / f'kit-grade-parallel-{i}'), range(2)))
    assert all(item['scores'] == grade['scores'] for item in parallel)
    assert all(item['scores_sha256'] == grade['scores_sha256'] for item in parallel)
    report = {
        'kind': 'local WASM experiment; not an eligible submission',
        'node': subprocess.check_output([NODE, '--version'], text=True).strip(),
        'rustc': subprocess.check_output([str(Path.home() / '.cargo/bin/rustc'), '--version'], text=True).strip(),
        'cargo': subprocess.check_output([str(Path.home() / '.cargo/bin/cargo'), '--version'], text=True).strip(),
        'build': {
            'target': 'wasm32-unknown-unknown',
            'profile': 'release, opt-level 3, fat LTO, one codegen unit, panic abort, stripped symbols',
            'simd128': 'enabled by .cargo/config.toml target rustflags',
        },
        'l1_expected_sha256': EXPECTED,
        'v3_runs': [v3_first, v3_second],
        'wasm_runs': [new_first, new_second],
        'existing_edges': edge.stdout.strip(),
        'boundary_tests': 'See differential edge test log; includes lone surrogates, memory growth and callback lifetime.',
        'fuzz': fuzzes,
        'kit_serial': grade,
        'kit_parallel': parallel,
        'kit_scores_equal': True,
        'kit_l1_reproduced': grade['l1'],
        'wasm_sha256': digest(ROOT / 'target/wasm32-unknown-unknown/release/csv_wasm_local.wasm'),
        'wasm_bytes': (ROOT / 'target/wasm32-unknown-unknown/release/csv_wasm_local.wasm').stat().st_size,
    }
    (root_out / 'self-verification.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


def timing(root_out):
    root_out.mkdir(parents=True, exist_ok=True)
    input_dir = KIT / 'practice/input'
    expected = {'v10-wasm': ROOT, 'v3': V3, 'control': PROJECT / 'control'}
    rounds = 7
    records = []

    def execute(name, bot, round_index):
        run_dir = root_out / f'round-{round_index:02d}-{name}'
        output_dir = run_dir / 'output'
        output_dir.mkdir(parents=True)
        stdout_path = run_dir / 'stdout.txt'
        stderr_path = run_dir / 'stderr.txt'
        env = dict(os.environ, MAKEFUN_INPUT_DIR=str(input_dir), MAKEFUN_OUTPUT_DIR=str(output_dir))
        stdout_fd = os.open(stdout_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        stderr_fd = os.open(stderr_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        started = time.perf_counter_ns()
        pid = os.fork()
        if pid == 0:
            try:
                os.dup2(stdout_fd, 1)
                os.dup2(stderr_fd, 2)
                os.close(stdout_fd)
                os.close(stderr_fd)
                argv = ['taskset', '-c', '0', NODE, str(bot / 'main.ts')]
                os.execvpe(argv[0], argv, env)
            except BaseException as error:
                os.write(2, (repr(error) + '\n').encode())
                os._exit(127)
        os.close(stdout_fd)
        os.close(stderr_fd)
        waited, status, usage = os.wait4(pid, 0)
        wall_ms = (time.perf_counter_ns() - started) / 1_000_000
        if waited != pid or os.waitstatus_to_exitcode(status) != 0:
            raise RuntimeError(f'{name} failed, status={status}: {stderr_path.read_text(errors="replace")[-2000:]}')
        if wall_ms > 10_000 or usage.ru_maxrss > 1024 * 1024:
            raise AssertionError(f'{name} exceeded the declared process budget: wall={wall_ms:.1f}ms rss={usage.ru_maxrss}KiB')
        answer = output_dir / 'answers.json'
        result = {
            'round': round_index,
            'name': name,
            'gross_cpu_us': round((usage.ru_utime + usage.ru_stime) * 1_000_000),
            'wall_ms': round(wall_ms, 3),
            'peak_rss_kb': usage.ru_maxrss,
            'answers_sha256': digest(answer),
            'answers_bytes': answer.stat().st_size,
        }
        if name != 'control' and result['answers_sha256'] != EXPECTED:
            raise AssertionError(f'{name} run {round_index} answer SHA mismatch: {result}')
        answer.unlink()
        return result

    node_version = subprocess.check_output([NODE, '--version'], text=True).strip()
    affinity = subprocess.run(['taskset', '-c', '0', 'true'], capture_output=True)
    if affinity.returncode:
        raise RuntimeError('CPU 0 is not available for taskset timing')
    for round_index in range(1, rounds + 1):
        for name in ('v10-wasm', 'v3', 'control'):
            row = execute(name, expected[name], round_index)
            records.append(row)
            print(f"round={round_index} {name}: gross={row['gross_cpu_us']}us wall={row['wall_ms']}ms rss={row['peak_rss_kb']}KiB sha={row['answers_sha256']}", flush=True)

    grouped = {name: [r for r in records if r['name'] == name] for name in expected}
    control_median = statistics.median(r['gross_cpu_us'] for r in grouped['control'])
    for name in ('v10-wasm', 'v3'):
        for row in grouped[name]:
            row['net_cpu_us'] = max(row['gross_cpu_us'] - control_median, 0)
    candidate_median = statistics.median(r['net_cpu_us'] for r in grouped['v10-wasm'])
    v3_median = statistics.median(r['net_cpu_us'] for r in grouped['v3'])
    wins = sum(a['net_cpu_us'] < b['net_cpu_us'] for a, b in zip(grouped['v10-wasm'], grouped['v3']))
    report = {
        'measurement': 'local process-driver proxy; Node 24; full process CPU, not an official score or ranking',
        'node': node_version,
        'node_binary': NODE,
        'kit': str(KIT),
        'input_sha256': digest(input_dir / 'cases.json'),
        'cpu_affinity': [0],
        'execution_order': ['v10-wasm', 'v3', 'control'] * rounds,
        'rounds': rounds,
        'control_gross_cpu_us': [r['gross_cpu_us'] for r in grouped['control']],
        'control_median_cpu_us': control_median,
        'candidate_gross_cpu_us': [r['gross_cpu_us'] for r in grouped['v10-wasm']],
        'candidate_net_cpu_us': [r['net_cpu_us'] for r in grouped['v10-wasm']],
        'candidate_median_net_cpu_us': candidate_median,
        'candidate_wall_ms': [r['wall_ms'] for r in grouped['v10-wasm']],
        'candidate_peak_rss_kb': [r['peak_rss_kb'] for r in grouped['v10-wasm']],
        'v3_gross_cpu_us': [r['gross_cpu_us'] for r in grouped['v3']],
        'v3_net_cpu_us': [r['net_cpu_us'] for r in grouped['v3']],
        'v3_median_net_cpu_us': v3_median,
        'v3_wall_ms': [r['wall_ms'] for r in grouped['v3']],
        'v3_peak_rss_kb': [r['peak_rss_kb'] for r in grouped['v3']],
        'paired_candidate_wins': wins,
        'relative_net_change_percent': round((candidate_median - v3_median) / v3_median * 100, 2) if v3_median else None,
        'gate': {
            'median_net_at_most_half_v3': candidate_median <= 0.5 * v3_median,
            'at_least_5_of_7_pairs_faster': wins >= 5,
            'pass': candidate_median <= 0.5 * v3_median and wins >= 5,
        },
        'runs': records,
    }
    (root_out / 'timing-v10.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))



if __name__ == '__main__':
    if len(sys.argv) not in {3, 4} or sys.argv[1] not in {'check', 'time', 'edges', 'fuzz'}:
        raise SystemExit('Usage: python3 tests/practice.py check|time RESULT_DIRECTORY | edges KIT | fuzz KIT SHARD')
    if sys.argv[1] == 'edges':
        subprocess.run([NODE, str(ROOT / 'tests/differential.mjs'), 'edges', str(Path(sys.argv[2]).resolve())], check=True)
    elif sys.argv[1] == 'fuzz':
        if len(sys.argv) != 4:
            raise SystemExit('fuzz requires KIT and SHARD')
        subprocess.run([NODE, str(ROOT / 'tests/differential.mjs'), 'fuzz', str(Path(sys.argv[2]).resolve()), sys.argv[3]], check=True)
    else:
        if len(sys.argv) != 3:
            raise SystemExit('check/time requires a result directory')
        destination = Path(sys.argv[2]).resolve()
        if sys.argv[1] == 'check':
            check(destination)
        else:
            timing(destination)
