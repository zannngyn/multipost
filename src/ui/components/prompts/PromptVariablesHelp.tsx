import { Banner, Code, HStack, Heading, Section, Stack, Text, Token } from "@astryxdesign/core";

import {
  PROMPT_VARIABLE_HINTS,
  PROMPT_VARIABLE_WHITELIST,
  REQUIRED_PROMPT_VARIABLES,
} from "@/ui/schemas/prompt.schema";

/**
 * The reference an operator needs while writing a prompt: which variables
 * exist, which are mandatory, and — the part that matters most — which will
 * never exist.
 *
 * Business rule 2 is stated out loud here, as a warning banner rather than one
 * more paragraph: there is no price or stock variable, and a body that invents
 * one is refused at save time. Saying it here is cheaper than letting someone
 * write a template, hit a 400 and guess why.
 *
 * Presentational: no props, no fetching. The list mirrors the server whitelist.
 */
export function PromptVariablesHelp({ id }: { id?: string }) {
  const required = new Set<string>(REQUIRED_PROMPT_VARIABLES);
  const headingId = `${id ?? "prompt-vars"}-heading`;

  return (
    // `role="complementary"` keeps the landmark this block had as an <aside>:
    // Astryx's Section is a visual container, not a semantic one.
    <Section
      id={id}
      variant="muted"
      padding={4}
      role="complementary"
      aria-labelledby={headingId}
    >
      <Stack direction="vertical" gap={3}>
        <Heading id={headingId} level={4}>
          Biến được phép dùng trong nội dung prompt
        </Heading>

        {/* A real <ul>/<li> so the count is announced; the variable itself
            leads each row because that is what the operator is looking for. */}
        <Stack as="ul" direction="vertical" gap={1.5}>
          {PROMPT_VARIABLE_WHITELIST.map((name) => (
            <HStack as="li" key={name} gap={2} align="center" wrap="wrap">
              <Code>{`{{${name}}}`}</Code>
              <Text type="supporting">{PROMPT_VARIABLE_HINTS[name]}</Text>
              {/* Marked in words, not just colour: "bắt buộc" is what an
                  operator scans for (core-accessibility §5). */}
              {required.has(name) ? <Token size="sm" color="orange" label="Bắt buộc" /> : null}
            </HStack>
          ))}
        </Stack>

        <Banner
          status="warning"
          title="Không có biến giá hay tồn kho, và sẽ không bao giờ có"
          description="Prompt dùng biến ngoài danh sách trên (ví dụ {{product.price}}) sẽ bị máy chủ từ chối ngay khi lưu — thông tin giá, tồn, lưu ý sản xuất không được phép đi vào caption."
        />
      </Stack>
    </Section>
  );
}
