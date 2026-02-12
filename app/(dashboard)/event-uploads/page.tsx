export default function EventUploadsPage() {
  return (
    <>
      <section className="page-header">
        <div>
          <h1>Event Uploads</h1>
          <p>Upload event documents and assets.</p>
        </div>
      </section>

      <section className="grid-two">
        <div className="panel">
          <div className="panel-header">
            <h2>Upload Queue</h2>
          </div>
          <div className="panel-body" />
        </div>
        <div className="panel">
          <div className="panel-header">
            <h2>Recent Uploads</h2>
          </div>
          <div className="panel-body" />
        </div>
      </section>
    </>
  );
}
