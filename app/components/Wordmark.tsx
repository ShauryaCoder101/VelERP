/* One tightly-cropped raster of the mark, 13KB, served from one place.
   The source PNG was 1000x1000 with ~80% of its pixels empty padding. */
export default function Wordmark({ className = "" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`wordmark ${className}`.trim()}
      src="/velocity-wordmark.png"
      alt="Velocity"
      width={640}
      height={148}
      decoding="async"
    />
  );
}
