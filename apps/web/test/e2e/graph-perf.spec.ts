import { expect, test } from './fixtures';

// T17 performance target (plan #t17): 2,000 notes and 5,000 links at 30 fps or better,
// measured in the browser on the real canvas while the layout is still moving (every
// frame steps the simulation and redraws everything), then while zooming.

interface Inspector {
  readonly settled: boolean;
  frameTimes(): number[];
  readonly nodeCount: number;
}

test('T17: the graph of 2,000 notes and 5,000 links runs at 30 fps or better @perf', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/test/perf/graph.html');
  const canvas = page.getByTestId('graph-canvas');
  await expect(canvas).toBeVisible();
  await expect(page.getByTestId('graph-count')).toHaveText(/^2000 notes · \d{4} links$/);

  /** Frames per second over `ms`, from the browser's own frame timestamps. */
  const measure = (ms: number) =>
    page.evaluate(async (duration) => {
      const graph = (
        document.querySelector('[data-testid="graph-canvas"]') as unknown as {
          penmossGraph: Inspector;
        }
      ).penmossGraph;
      const before = graph.frameTimes().length;
      const stamps: number[] = [];
      await new Promise<void>((resolve) => {
        const step = (time: number) => {
          stamps.push(time);
          if (time - stamps[0]! < duration) requestAnimationFrame(step);
          else resolve();
        };
        requestAnimationFrame(step);
      });
      const seconds = (stamps.at(-1)! - stamps[0]!) / 1000;
      const work = graph.frameTimes().slice(-Math.max(1, stamps.length - 1));
      work.sort((a, b) => a - b);
      return {
        fps: (stamps.length - 1) / seconds,
        graphFrames: graph.frameTimes().length - before,
        medianWork: work[Math.floor(work.length / 2)] ?? 0,
        nodes: graph.nodeCount,
      };
    }, ms);

  // While the layout moves: a simulation step and a full redraw every frame.
  const moving = await measure(2000);
  test.info().annotations.push({ type: 'moving', description: JSON.stringify(moving) });
  console.log('[graph perf] moving', JSON.stringify(moving));
  expect(moving.nodes).toBe(2000);
  expect(moving.graphFrames).toBeGreaterThan(30);
  expect(moving.fps).toBeGreaterThanOrEqual(30);

  // Zooming: a wheel event every frame, dispatched in the page (input sent through the
  // DevTools protocol paces frames itself, so it would measure Playwright, not the graph).
  const zooming = page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="graph-canvas"]')!;
    const box = canvas.getBoundingClientRect();
    let frames = 0;
    const step = () => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: frames % 40 < 20 ? -30 : 30,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }),
      );
      if (++frames < 120) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
  const zoomed = await measure(1500);
  await zooming;
  test.info().annotations.push({ type: 'zooming', description: JSON.stringify(zoomed) });
  console.log('[graph perf] zooming', JSON.stringify(zoomed));
  expect(zoomed.graphFrames).toBeGreaterThan(30);
  expect(zoomed.fps).toBeGreaterThanOrEqual(30);
});
