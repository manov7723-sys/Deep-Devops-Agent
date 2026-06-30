import { TwoFaClient } from "./TwoFaClient";

export const metadata = {
  title: "Two-factor authentication · DeepAgent",
};

export default async function TwoFaPage({
  searchParams,
}: {
  searchParams: Promise<{ setup?: string }>;
}) {
  const params = await searchParams;
  const setup = params.setup === "1" || params.setup === "true";
  return <TwoFaClient setup={setup} />;
}
