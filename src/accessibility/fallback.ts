import { UnsupportedFeatureError } from '../core/errors';
import { createPipeline, type Pipeline, type PipelineOptions } from '../gl/pipeline';

export interface AccessiblePipeline {
  readonly pipeline: Pipeline | null;
  readonly reason: UnsupportedFeatureError | null;
  dispose(): void;
}

/** The caller supplies semantic HTML describing the scene and any equivalent controls. */
export function createAccessiblePipeline(host: HTMLElement, fallback: HTMLElement, options: PipelineOptions = {}): AccessiblePipeline {
  const originalHidden = fallback.hidden;
  let pipeline: Pipeline;
  try {
    pipeline = createPipeline(host, options);
  } catch (error) {
    if (!(error instanceof UnsupportedFeatureError)) throw error;
    fallback.hidden = false;
    return { pipeline: null, reason: error, dispose: () => { fallback.hidden = originalHidden; } };
  }
  const canvas = pipeline.renderer.domElement;
  canvas.setAttribute('aria-hidden', 'true');
  const showState = (status: Pipeline['status']): void => {
    fallback.hidden = status === 'ready';
    canvas.hidden = status !== 'ready';
  };
  showState(pipeline.status);
  const unsubscribe = pipeline.onContextChange(showState);
  return {
    pipeline,
    reason: null,
    dispose(): void {
      unsubscribe();
      pipeline.dispose();
      fallback.hidden = originalHidden;
    },
  };
}
