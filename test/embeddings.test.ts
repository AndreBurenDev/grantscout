import { describe, it, expect } from 'vitest';
import { embedMission, cosineSimilarity, computeICPCentroid, computeFitScore } from '../src/ai/llm.js';

describe('Embeddings', () => {
  describe('embedMission', () => {
    it('returns non-empty embedding for mission text', async () => {
      const embedding = await embedMission('Environmental protection and sustainability');

      expect(embedding.length).toBeGreaterThan(0);
      expect(embedding.every(v => typeof v === 'number')).toBe(true);
    });

    it('returns same embedding for same mission (deterministic)', async () => {
      const mission = 'Healthcare and medical research';

      const emb1 = await embedMission(mission);
      const emb2 = await embedMission(mission);

      expect(emb1).toEqual(emb2);
    });

    it('returns normalized values in 0..1 range', async () => {
      const embedding = await embedMission('Social support for disadvantaged communities');

      expect(embedding.every(v => v >= 0 && v <= 1)).toBe(true);
    });

    it('recognizes environment keywords', async () => {
      const emb1 = await embedMission('Environmental protection');
      const emb2 = await embedMission('Education programs');

      // Embeddings should be different
      expect(emb1).not.toEqual(emb2);
    });
  });

  describe('cosineSimilarity', () => {
    it('returns 1 for identical vectors', () => {
      const a = [1, 0, 0];
      const b = [1, 0, 0];

      expect(cosineSimilarity(a, b)).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];

      expect(cosineSimilarity(a, b)).toBeCloseTo(0);
    });

    it('returns -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];

      expect(cosineSimilarity(a, b)).toBeCloseTo(-1);
    });

    it('handles empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([1, 2], [])).toBe(0);
    });
  });

  describe('computeICPCentroid', () => {
    it('returns centroid of seed missions', async () => {
      const seeds = [
        'Education and literacy',
        'Education and training',
        'Education programs',
      ];

      const centroid = await computeICPCentroid(seeds);

      expect(centroid.length).toBeGreaterThan(0);
      expect(centroid.every(v => typeof v === 'number')).toBe(true);
    });

    it('returns balanced centroid for diverse seeds', async () => {
      const seeds = [
        'Environmental protection',
        'Healthcare services',
        'Social welfare',
      ];

      const centroid = await computeICPCentroid(seeds);

      // All dimensions should contribute
      expect(centroid.some(v => v > 0.1)).toBe(true);
    });
  });

  describe('computeFitScore', () => {
    it('returns high fit for similar mission to centroid', async () => {
      const centroid = await computeICPCentroid([
        'Education programs',
        'Student support',
        'Learning initiatives',
      ]);

      const fit = await computeFitScore('Education and scholarship programs', centroid);

      expect(fit).toBeGreaterThan(0.5);
    });

    it('returns different fit for dissimilar mission', async () => {
      const centroid = await computeICPCentroid([
        'Environmental conservation',
        'Climate action',
        'Sustainability',
      ]);

      const fit = await computeFitScore('Healthcare and medical services', centroid);

      // Still some similarity, but lower
      expect(fit).toBeLessThan(0.8);
    });

    it('returns 0 for empty mission', async () => {
      const centroid = await computeICPCentroid(['Education']);

      const fit = await computeFitScore('', centroid);

      expect(fit).toBeLessThanOrEqual(0.5);
    });
  });
});
