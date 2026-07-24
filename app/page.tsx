import Palimpsest from "./Palimpsest";

export default function Home() {
  return (
    <>
      <div className="visually-hidden">
        <h1>Palimpsest</h1>
        <p>
          Palimpsest is a shared canvas edited with GPT Image 2—named for a surface
          rewritten while traces of what came before remain.
        </p>
      </div>
      <Palimpsest />
    </>
  );
}
