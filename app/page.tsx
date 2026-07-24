import Palimpsest from "./Palimpsest";

export default function Home() {
  return (
    <>
      <div className="visually-hidden">
        <h1>Palimpsest</h1>
        <p>
          A shared canvas edited with GPT Image 2. Add to the image and explore every
          revision.
        </p>
      </div>
      <Palimpsest />
    </>
  );
}
