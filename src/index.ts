#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";
import axios, { AxiosInstance } from 'axios';

// --- Configuration ---
const TANDOOR_URL = process.env.TANDOOR_URL;
// check if TANDOOR_API_TOKEN is empty, and if so, copy TANDOOR_API_KEY to TANDOOR_API_TOKEN
// cline likes to use KEY for the token, but Tandoor uses TOKEN
const TANDOOR_API_TOKEN = process.env.TANDOOR_API_TOKEN
  ? process.env.TANDOOR_API_TOKEN
  : process.env.TANDOOR_API_KEY; 

  if (!TANDOOR_URL) {
  console.error("[Error] TANDOOR_URL environment variable is required.");
  process.exit(1);
}
if (!TANDOOR_API_TOKEN) {
  console.error("[Error] TANDOOR_API_TOKEN environment variable is required.");
  process.exit(1);
}

// --- Tandoor API Types (Simplified) ---
interface TandoorFoodInput {
  id?: number;
  name: string;
}

interface TandoorUnitInput {
  id?: number;
  name: string;
}

interface TandoorIngredientInput {
  food: TandoorFoodInput | null;
  unit?: TandoorUnitInput; // omitted entirely when the line named no unit
  amount: number;
  note?: string;
}

// One entry of IngredientParserResponse.ingredients
// (POST /api/ingredient-parser/post/). food and unit are resolved against the
// space's existing records, so they come back with real ids.
interface TandoorParsedIngredient {
  food: TandoorFoodInput | null;
  unit: TandoorUnitInput | null;
  amount: number;
  note?: string | null;
  original_text?: string | null;
}

interface TandoorStepInput {
  instruction: string;
  ingredients: TandoorIngredientInput[];
}

interface TandoorRecipeInput {
  name: string;
  description?: string;
  servings?: number;
  steps: TandoorStepInput[];
}

interface TandoorMealType {
    id: number;
    name: string;
}

interface TandoorRecipeOverview {
    id: number;
    name: string;
}

interface TandoorMealPlanInput {
    recipe: { 
        id: number;
        name: string;
        keywords: any[]; // API requires keywords field
    }; 
    meal_type: { 
        id: number;
        name: string;
    }; 
    from_date: string; // YYYY-MM-DD
    to_date?: string; // YYYY-MM-DD
    servings: string; // Tandoor API expects string
    title?: string;
    note?: string;
}

// --- Axios Instance ---
const apiClient: AxiosInstance = axios.create({
  baseURL: TANDOOR_URL,
  headers: {
    'Authorization': `Bearer ${TANDOOR_API_TOKEN}`,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  }
});

// --- MCP Server Setup ---
const server = new Server(
  {
    name: "tandoor-mcp-server",
    version: "0.1.0",
    description: "A Model Context Protocol Server to interact with Tandoor, a self-hosted recipe manager."
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// --- Tool Definitions ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error("[Info] Listing tools");
  return {
    tools: [
      // --- Existing Tools ---
      {
        name: "create_tandoor_recipe",
        description: "Create a new recipe in Tandoor.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "The name of the recipe." },
            description: { type: "string", description: "Optional description for the recipe." },
            servings: { type: "number", description: "Optional number of servings." },
            ingredients_block: { type: "string", description: "A multi-line block of text listing ingredients, one per line (e.g., '1 cup flour\\n2 eggs')." },
            instructions_block: { type: "string", description: "A multi-line block of text detailing the recipe instructions." },
          },
          required: ["name", "ingredients_block", "instructions_block"],
        },
      },
      {
        name: "create_tandoor_meal_plan",
        description: "Add one or more recipes to the Tandoor meal plan for a specific date and meal type.",
        inputSchema: {
            type: "object",
            properties: {
                title: { type: "string", description: "Optional title for the meal plan entry." },
                recipes: {
                    type: "array",
                    items: { type: ["string", "number"] }, // Allow recipe names (string) or IDs (number)
                    description: "An array of recipe names or recipe IDs to add to the plan."
                },
                start_date: { type: "string", format: "date", description: "The date for the meal plan entry (YYYY-MM-DD)." },
                meal_type: { type: "string", description: "The name of the meal type (e.g., 'Dinner', 'Lunch'). Must match an existing meal type in Tandoor." },
                servings: { type: "number", description: "Optional number of servings for the meal plan entry (default: 1).", default: 1 },
                note: { type: "string", description: "Optional note for the meal plan entry." },
            },
            required: ["recipes", "start_date", "meal_type"],
        },
      },
      {
        name: "get_recipes",
        description: "Search for recipes in Tandoor based on various criteria.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search term for recipe names." },
            keywords: { type: "array", items: { type: "integer" }, description: "Array of Keyword IDs (match ANY)." },
            foods: { type: "array", items: { type: "integer" }, description: "Array of Food IDs (match ANY)." },
            rating: { type: "integer", minimum: 0, maximum: 5, description: "Minimum rating (0-5)." },
            limit: { type: "integer", description: "Max number of recipes to return (default: 10).", default: 10 }
          },
          required: []
        },
      },
      {
        name: "get_meal_plans",
        description: "Retrieve meal plan entries from Tandoor, optionally filtering by date range and meal type.",
        inputSchema: {
          type: "object",
          properties: {
            from_date: { type: "string", format: "date", description: "Optional start date (YYYY-MM-DD) filter (inclusive)." },
            to_date: { type: "string", format: "date", description: "Optional end date (YYYY-MM-DD) filter (inclusive)." },
            meal_type_id: { type: "integer", description: "Optional Meal Type ID to filter by." }
          },
          required: []
        },
      },
      // --- New Tools ---
      {
        name: "get_recipe_details",
        description: "Retrieve the full details of a specific recipe.",
        inputSchema: {
          type: "object",
          properties: {
            recipe_id: { type: "integer", description: "The ID of the recipe to retrieve." }
          },
          required: ["recipe_id"]
        },
      },
      {
        name: "get_meal_types",
        description: "List all available meal types in Tandoor.",
        inputSchema: { type: "object", properties: {}, required: [] } // No input needed
      },
      {
        name: "get_keywords",
        description: "List or search for keywords.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search term for keyword name." },
            root: { type: "integer", description: "Optional ID to get first-level children (0 for root)." },
            tree: { type: "integer", description: "Optional ID to get all children in a tree." }
          },
          required: []
        },
      },
      {
        name: "get_foods",
        description: "List or search for foods.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search term for food name." },
            root: { type: "integer", description: "Optional ID to get first-level children (0 for root)." },
            tree: { type: "integer", description: "Optional ID to get all children in a tree." }
          },
          required: []
        },
      },
      {
        name: "get_units",
        description: "List or search for units.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Optional search term for unit name." }
          },
          required: []
        },
      },
      {
        name: "get_shopping_list",
        description: "Retrieve the current shopping list items.",
        inputSchema: {
          type: "object",
          properties: {
            checked: { type: "string", enum: ["true", "false", "both", "recent"], description: "Filter by checked status (default: recent)." }
          },
          required: []
        },
      },
      {
        name: "add_shopping_list_item",
        description: "Add an item to the shopping list, allowing food/unit names or IDs.",
        inputSchema: {
          type: "object",
          properties: {
            food_name_or_id: { type: ["string", "integer"], description: "The name or ID of the food item." },
            amount: { type: "string", description: "The amount needed (e.g., '1', '2.5', '1/2')." },
            unit_name_or_id: { type: ["string", "integer"], description: "The name or ID of the unit (e.g., 'cup', 'g', 5)." },
            note: { type: "string", description: "Optional note for the item." }
          },
          required: ["food_name_or_id", "amount", "unit_name_or_id"]
        },
      },
      {
        name: "update_shopping_list_item",
        description: "Update an existing shopping list item (e.g., check/uncheck, change amount).",
        inputSchema: {
          type: "object",
          properties: {
            item_id: { type: "integer", description: "The ID of the shopping list item to update." },
            amount: { type: "string", description: "Optional new amount." },
            unit_id: { type: "integer", description: "Optional new unit ID." },
            checked: { type: "boolean", description: "Optional new checked status." },
            note: { type: "string", description: "Optional new note." }
          },
          required: ["item_id"]
        },
      },
      {
        name: "remove_shopping_list_item",
        description: "Remove an item from the shopping list.",
        inputSchema: {
          type: "object",
          properties: {
            item_id: { type: "integer", description: "The ID of the shopping list item to remove." }
          },
          required: ["item_id"]
        },
      }
    ],
  };
});

// --- Tool Implementation ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  console.error(`[Info] Received tool call: ${request.params.name}`);
  try {
    switch (request.params.name) {
      // --- create_tandoor_recipe ---
      case "create_tandoor_recipe": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid arguments object.");
        }
        const name = args.name as string;
        const description = args.description as string | undefined;
        const servings = args.servings as number | undefined;
        const ingredients_block = args.ingredients_block as string;
        const instructions_block = args.instructions_block as string;

        if (!name || !ingredients_block || !instructions_block) {
          throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: name, ingredients_block, instructions_block.");
        }

        // Ingredient parsing is delegated to Tandoor's own parser
        // (POST /api/ingredient-parser/post/). It resolves the amount including
        // fractions ("1/2", "\u00bd") and ranges, matches the unit against the
        // space's existing units, splits a trailing ", note" off the food name,
        // and applies the space's food/unit automation rules. The previous
        // implementation sent the entire line as the food name with a hardcoded
        // amount of 1 and a unit literally named "unit" — that is what produced
        // the malformed Food and Unit records this replaces.
        const ingredientLines = ingredients_block
          .split('\n')
          .map(line => line.trim())
          .filter(line => line.length > 0);

        if (ingredientLines.length === 0) {
          throw new McpError(ErrorCode.InvalidParams, "ingredients_block contained no non-empty lines.");
        }

        console.error(`[API] POST /api/ingredient-parser/post/ - Parsing ${ingredientLines.length} ingredient line(s)`);
        let parsedIngredients: TandoorParsedIngredient[];
        try {
          const parseResponse = await apiClient.post('/api/ingredient-parser/post/', { ingredients: ingredientLines });
          console.error(`[API] POST /api/ingredient-parser/post/ - Status: ${parseResponse.status}`);
          parsedIngredients = parseResponse.data?.ingredients || [];
        } catch (err: any) {
          console.error(`[Error] Failed to parse ingredients:`, err);
          const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : 'No response data';
          throw new McpError(ErrorCode.InternalError, `Failed to parse ingredients: ${err.message} - API Response: ${errorDetail}`);
        }

        // Refuse to build a recipe out of a partial parse rather than silently
        // dropping or misaligning ingredients.
        if (parsedIngredients.length !== ingredientLines.length) {
          throw new McpError(
            ErrorCode.InternalError,
            `Ingredient parser returned ${parsedIngredients.length} result(s) for ${ingredientLines.length} line(s); refusing to create a recipe with mismatched ingredients.`
          );
        }

        const ingredients: TandoorIngredientInput[] = parsedIngredients.map((parsed) => {
          const ingredient: TandoorIngredientInput = {
            // Never fall back to the raw line. A null food is real data (a line
            // that parses to nothing but a note); a line-as-food-name is not.
            food: parsed.food ? { id: parsed.food.id, name: parsed.food.name } : null,
            // Tandoor represents "no amount given" as 0 and Ingredient.amount is
            // non-nullable, so pass the parser's value straight through rather
            // than defaulting to 1.
            amount: parsed.amount ?? 0,
          };
          // Omit unit entirely when the line named none — a missing unit is
          // correct data, a fabricated one is not.
          if (parsed.unit) {
            ingredient.unit = { id: parsed.unit.id, name: parsed.unit.name };
          }
          const note = parsed.note?.trim();
          if (note) {
            ingredient.note = note;
          }
          return ingredient;
        });

        console.error(`[Info] Parsed ${ingredients.length} ingredient(s): ${ingredients.map(i => `${i.amount} ${i.unit?.name ?? ''} ${i.food?.name ?? '?'}`.replace(/\s+/g, ' ').trim()).join(' | ')}`);

        const recipePayload: TandoorRecipeInput = {
          name: name,
          description: description,
          servings: servings,
          steps: [
            {
              instruction: instructions_block,
              ingredients: ingredients,
            },
          ],
        };

        console.error(`[API] POST /api/recipe/ - Payload: ${JSON.stringify(recipePayload)}`);
        const response = await apiClient.post('/api/recipe/', recipePayload);
        console.error(`[API] POST /api/recipe/ - Status: ${response.status}`);

        const newRecipeId = response.data?.id;
        const successMsg = `Successfully created recipe "${name}" in Tandoor (ID: ${newRecipeId || 'unknown'}).`;
        console.error(`[Info] ${successMsg}`);
        return { content: [{ type: "text", text: successMsg }] };
      }

      // --- create_tandoor_meal_plan ---
      case "create_tandoor_meal_plan": {
        const args = request.params.arguments;
         if (!args || typeof args !== 'object' || args === null) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid arguments object.");
        }
        const recipesInput = args.recipes as (string | number)[];
        const startDate = args.start_date as string;
        const mealTypeName = args.meal_type as string;
        const title = args.title as string | undefined;
        const servings = args.servings as number ?? 1; // Default to 1 serving
        const note = args.note as string | undefined;


        if (!recipesInput || !Array.isArray(recipesInput) || recipesInput.length === 0 || !startDate || !mealTypeName) {
            throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: recipes (array), start_date, meal_type.");
        }
         // Validate date format (basic)
        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid start_date format. Use YYYY-MM-DD.");
        }

        // 1. Find Meal Type ID
        console.error(`[API] GET /api/meal-type/ - Fetching meal types`);
        const mealTypesResponse = await apiClient.get('/api/meal-type/');
        console.error(`[API] GET /api/meal-type/ - Status: ${mealTypesResponse.status}, Data: ${JSON.stringify(mealTypesResponse.data)}`); // Log received data
        const availableMealTypes: TandoorMealType[] = mealTypesResponse.data.results || mealTypesResponse.data || []; // Handle paginated and non-paginated
        const mealType = availableMealTypes.find(mt => mt.name.toLowerCase() === mealTypeName.toLowerCase());

        if (!mealType) {
            console.error(`[Error] Meal type "${mealTypeName}" not found in received data.`); // More specific log
            throw new McpError(ErrorCode.InvalidParams, `Meal type "${mealTypeName}" not found in Tandoor.`);
        }
        const mealTypeId = mealType.id;
        console.error(`[Info] Found Meal Type ID: ${mealTypeId} for "${mealTypeName}"`);

        // 2. Resolve Recipe IDs
        const recipeIds: number[] = [];
        const errors: string[] = [];
        for (const recipeRef of recipesInput) {
            if (typeof recipeRef === 'number') {
                recipeIds.push(recipeRef);
            } else if (typeof recipeRef === 'string') {
                try {
                    console.error(`[API] GET /api/recipe/?query=${encodeURIComponent(recipeRef)} - Searching for recipe`);
                    const searchResponse = await apiClient.get<{ results: TandoorRecipeOverview[] }>(`/api/recipe/?query=${encodeURIComponent(recipeRef)}`);
                    console.error(`[API] GET /api/recipe/?query=${encodeURIComponent(recipeRef)} - Status: ${searchResponse.status}`);

                    if (searchResponse.data.results && searchResponse.data.results.length > 0) {
                        // Simple approach: take the first match
                        const foundId = searchResponse.data.results[0].id;
                        recipeIds.push(foundId);
                        console.error(`[Info] Found Recipe ID: ${foundId} for "${recipeRef}"`);
                        if (searchResponse.data.results.length > 1) {
                             console.warn(`[Warning] Multiple recipes found for "${recipeRef}". Using the first match (ID: ${foundId}).`);
                        }
                    } else {
                        errors.push(`Recipe named "${recipeRef}" not found.`);
                        console.error(`[Error] Recipe named "${recipeRef}" not found.`);
                    }
                } catch (err: any) {
                     errors.push(`Error searching for recipe "${recipeRef}": ${err.message}`);
                     console.error(`[Error] Failed searching recipe "${recipeRef}":`, err);
                }
            }
        }

        if (errors.length > 0 && recipeIds.length === 0) {
             throw new McpError(ErrorCode.InternalError, `Could not resolve any recipe IDs. Errors: ${errors.join('; ')}`);
        }

        // 3. Create Meal Plan Entries
        const results: string[] = [];
        for (const recipeId of recipeIds) {
            // Get recipe details to include in the payload
            console.error(`[API] GET /api/recipe/${recipeId}/ - Fetching recipe details`);
            let recipeName = "Recipe";
            let recipeKeywords = [];
            try {
                const recipeResponse = await apiClient.get(`/api/recipe/${recipeId}/`);
                console.error(`[API] GET /api/recipe/${recipeId}/ - Status: ${recipeResponse.status}`);
                recipeName = recipeResponse.data.name || "Recipe";
                recipeKeywords = recipeResponse.data.keywords || [];
            } catch (err: any) {
                console.error(`[Warning] Could not fetch recipe details: ${err.message}`);
            }

            const mealPlanPayload: TandoorMealPlanInput = {
                recipe: { 
                    id: recipeId,
                    name: recipeName,
                    keywords: recipeKeywords
                },
                meal_type: { 
                    id: mealTypeId,
                    name: mealType.name
                },
                from_date: `${startDate}T00:00:00`, // Append time to match date-time format
                servings: String(servings), // API expects string
                title: title,
                note: note,
            };
            // Log the exact payload being sent
            console.error(`[API] POST /api/meal-plan/ - Payload for Recipe ID ${recipeId}: ${JSON.stringify(mealPlanPayload)}`);
            try {
                // console.error(`[API] POST /api/meal-plan/ - Payload: ${JSON.stringify(mealPlanPayload)}`); // Removed redundant log
                const planResponse = await apiClient.post('/api/meal-plan/', mealPlanPayload);
                console.error(`[API] POST /api/meal-plan/ - Status: ${planResponse.status}`);
                results.push(`Added recipe ID ${recipeId} to meal plan for ${startDate} (${mealTypeName}).`);
                console.error(`[Info] Added recipe ID ${recipeId} to meal plan.`);
            } catch (err: any) {
                 // Log the detailed error response from the API
                 const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : 'No response data';
                 const errorMsg = `Failed to add recipe ID ${recipeId} to meal plan: ${err.message} - API Response: ${errorDetail}`;
                 errors.push(errorMsg);
                 console.error(`[Error] ${errorMsg}`); // Log the detailed error
            }
        }

        let finalText = results.join('\n');
        if (errors.length > 0) {
            finalText += `\n\nErrors encountered:\n${errors.join('\n')}`;
        }

        return { content: [{ type: "text", text: finalText }] };
      }

      // --- get_recipes ---
      case "get_recipes": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid arguments object.");
        }
        
        const query = args.query as string | undefined;
        const keywords = args.keywords as number[] | undefined;
        const foods = args.foods as number[] | undefined;
        const rating = args.rating as number | undefined;
        const limit = args.limit as number || 10; // Default to 10 if not provided
        
        // Construct query parameters
        const params: Record<string, string | number> = { page_size: limit };
        
        if (query) {
          params.query = query;
        }
        
        // Build URL with query parameters
        let url = '/api/recipe/';
        const queryParams: string[] = [];
        
        // Add basic params
        if (query) queryParams.push(`query=${encodeURIComponent(query)}`);
        if (rating !== undefined) queryParams.push(`rating=${rating}`);
        if (limit) queryParams.push(`page_size=${limit}`);
        
        // Handle array parameters (keywords, foods)
        if (keywords && Array.isArray(keywords) && keywords.length > 0) {
          keywords.forEach(k => queryParams.push(`keywords_or=${k}`));
        }
        
        if (foods && Array.isArray(foods) && foods.length > 0) {
          foods.forEach(f => queryParams.push(`foods_or=${f}`));
        }
        
        // Add query parameters to URL
        if (queryParams.length > 0) {
          url += '?' + queryParams.join('&');
        }
        
        console.error(`[API] GET ${url} - Searching for recipes`);
        
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          
          const recipes = response.data.results || [];
          const count = response.data.count || 0;
          
          // Format the results
          const formattedRecipes = recipes.map((recipe: any) => ({
            id: recipe.id,
            name: recipe.name,
            description: recipe.description || '',
            rating: recipe.rating || 'Not rated',
            servings: recipe.servings || 0,
            keywords: (recipe.keywords || []).map((k: any) => ({ id: k.id, name: k.label }))
          }));
          
          const resultText = formattedRecipes.length > 0
            ? `Found ${count} recipes (showing ${formattedRecipes.length}):\n\n${formattedRecipes.map((r: { id: number; name: string; description: string; rating: string }) => 
                `ID: ${r.id} - ${r.name}${r.description ? '\nDescription: ' + r.description : ''}${r.rating ? '\nRating: ' + r.rating : ''}`
              ).join('\n\n')}`
            : 'No recipes found matching the criteria.';
            
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to search recipes:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to search recipes: ${err.message}`);
        }
      }
      
      // --- get_meal_plans ---
      case "get_meal_plans": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null) {
          throw new McpError(ErrorCode.InvalidParams, "Invalid arguments object.");
        }
        
        const fromDate = args.from_date as string | undefined;
        const toDate = args.to_date as string | undefined;
        const mealTypeId = args.meal_type_id as number | undefined;
        
        // Build URL with query parameters
        let url = '/api/meal-plan/';
        const queryParams: string[] = [];
        
        if (fromDate) {
          // Validate date format
          if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid from_date format. Use YYYY-MM-DD.");
          }
          queryParams.push(`from_date=${fromDate}`);
        }
        
        if (toDate) {
          // Validate date format
          if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate)) {
            throw new McpError(ErrorCode.InvalidParams, "Invalid to_date format. Use YYYY-MM-DD.");
          }
          queryParams.push(`to_date=${toDate}`);
        }
        
        if (mealTypeId !== undefined) {
          queryParams.push(`meal_type=${mealTypeId}`);
        }
        
        // Add query parameters to URL
        if (queryParams.length > 0) {
          url += '?' + queryParams.join('&');
        }
        
        console.error(`[API] GET ${url} - Fetching meal plans`);
        
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          
          const mealPlans = response.data.results || response.data || []; // Handle paginated and non-paginated
          
          // Format the results
          const formattedMealPlans = mealPlans.map((plan: any) => ({
            id: plan.id,
            title: plan.title || '',
            recipe: {
              id: plan.recipe?.id,
              name: plan.recipe?.name || 'Unknown Recipe'
            },
            meal_type: {
              id: plan.meal_type?.id,
              name: plan.meal_type?.name || 'Unknown Meal Type'
            },
            from_date: plan.from_date,
            servings: plan.servings,
            note: plan.note || ''
          }));
          
          const resultText = formattedMealPlans.length > 0
            ? `Found ${formattedMealPlans.length} meal plans:\n\n${formattedMealPlans.map((p: { id: number; title: string; recipe: { name: string; id: number }; meal_type: { name: string }; from_date: string; servings: string; note: string }) => 
                `ID: ${p.id}${p.title ? ' - ' + p.title : ''}\nRecipe: ${p.recipe.name} (ID: ${p.recipe.id})\nMeal Type: ${p.meal_type.name}\nDate: ${p.from_date.split('T')[0]}\nServings: ${p.servings}${p.note ? '\nNote: ' + p.note : ''}`
              ).join('\n\n')}`
            : 'No meal plans found matching the criteria.';
            
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch meal plans:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch meal plans: ${err.message}`);
        }
      }
      
      // --- get_recipe_details ---
      case "get_recipe_details": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null || typeof args.recipe_id !== 'number') {
          throw new McpError(ErrorCode.InvalidParams, "Missing or invalid required argument: recipe_id (number).");
        }
        const recipeId = args.recipe_id;
        const url = `/api/recipe/${recipeId}/`;
        console.error(`[API] GET ${url} - Fetching recipe details`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          // Return the full recipe data as JSON string
          return { content: [{ type: "text", text: JSON.stringify(response.data, null, 2) }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch recipe details for ID ${recipeId}:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch recipe details: ${err.message}`);
        }
      }

      // --- get_meal_types ---
      case "get_meal_types": {
        const url = '/api/meal-type/';
        console.error(`[API] GET ${url} - Fetching meal types`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          const mealTypes = response.data.results || response.data || []; // Handle paginated and non-paginated
          const resultText = mealTypes.length > 0
            ? `Available Meal Types:\n${mealTypes.map((mt: any) => `ID: ${mt.id} - Name: ${mt.name}`).join('\n')}`
            : 'No meal types found.';
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch meal types:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch meal types: ${err.message}`);
        }
      }

      // --- get_keywords ---
      case "get_keywords": {
        const args = request.params.arguments || {};
        const query = args.query as string | undefined;
        const root = args.root as number | undefined;
        const tree = args.tree as number | undefined;
        
        let url = '/api/keyword/';
        const queryParams: string[] = [];
        if (query) queryParams.push(`query=${encodeURIComponent(query)}`);
        if (root !== undefined) queryParams.push(`root=${root}`);
        if (tree !== undefined) queryParams.push(`tree=${tree}`);
        if (queryParams.length > 0) url += '?' + queryParams.join('&');

        console.error(`[API] GET ${url} - Fetching keywords`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          const keywords = response.data.results || response.data || []; // Handle paginated and non-paginated
          const resultText = keywords.length > 0
            ? `Found Keywords:\n${keywords.map((k: any) => `ID: ${k.id} - Name: ${k.name}${k.description ? ' - ' + k.description : ''}`).join('\n')}`
            : 'No keywords found.';
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch keywords:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch keywords: ${err.message}`);
        }
      }

      // --- get_foods ---
      case "get_foods": {
        const args = request.params.arguments || {};
        const query = args.query as string | undefined;
        const root = args.root as number | undefined;
        const tree = args.tree as number | undefined;
        
        let url = '/api/food/';
        const queryParams: string[] = [];
        if (query) queryParams.push(`query=${encodeURIComponent(query)}`);
        if (root !== undefined) queryParams.push(`root=${root}`);
        if (tree !== undefined) queryParams.push(`tree=${tree}`);
        if (queryParams.length > 0) url += '?' + queryParams.join('&');

        console.error(`[API] GET ${url} - Fetching foods`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          const foods = response.data.results || response.data || []; // Handle paginated and non-paginated
          const resultText = foods.length > 0
            ? `Found Foods:\n${foods.map((f: any) => `ID: ${f.id} - Name: ${f.name}${f.description ? ' - ' + f.description : ''}`).join('\n')}`
            : 'No foods found.';
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch foods:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch foods: ${err.message}`);
        }
      }

      // --- get_units ---
      case "get_units": {
        const args = request.params.arguments || {};
        const query = args.query as string | undefined;
        
        let url = '/api/unit/';
        const queryParams: string[] = [];
        if (query) queryParams.push(`query=${encodeURIComponent(query)}`);
        if (queryParams.length > 0) url += '?' + queryParams.join('&');

        console.error(`[API] GET ${url} - Fetching units`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          const units = response.data.results || response.data || []; // Handle paginated and non-paginated
          const resultText = units.length > 0
            ? `Found Units:\n${units.map((u: any) => `ID: ${u.id} - Name: ${u.name}${u.description ? ' - ' + u.description : ''}`).join('\n')}`
            : 'No units found.';
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch units:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch units: ${err.message}`);
        }
      }

      // --- get_shopping_list ---
      case "get_shopping_list": {
        const args = request.params.arguments || {};
        const checked = args.checked as string || "recent"; // Default to recent
        
        let url = '/api/shopping-list-entry/';
        const queryParams: string[] = [`checked=${checked}`];
        url += '?' + queryParams.join('&');

        console.error(`[API] GET ${url} - Fetching shopping list`);
        try {
          const response = await apiClient.get(url);
          console.error(`[API] GET ${url} - Status: ${response.status}`);
          const items = response.data.results || response.data || []; // Handle paginated and non-paginated
          const resultText = items.length > 0
            ? `Shopping List Items (${checked}):\n${items.map((item: any) => 
                `ID: ${item.id} - ${item.amount} ${item.unit?.name || '?'} ${item.food?.name || '?'} ${item.checked ? '[Checked]' : ''}${item.note ? ' (Note: ' + item.note + ')' : ''}`
              ).join('\n')}`
            : `No shopping list items found (filter: ${checked}).`;
          return { content: [{ type: "text", text: resultText }] };
        } catch (err: any) {
          console.error(`[Error] Failed to fetch shopping list:`, err);
          throw new McpError(ErrorCode.InternalError, `Failed to fetch shopping list: ${err.message}`);
        }
      }

      // --- add_shopping_list_item ---
      case "add_shopping_list_item": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null || !args.food_name_or_id || !args.amount || !args.unit_name_or_id) {
          throw new McpError(ErrorCode.InvalidParams, "Missing required arguments: food_name_or_id, amount, unit_name_or_id.");
        }
        
        const foodRef = args.food_name_or_id as string | number;
        const amount = args.amount as string;
        const unitRef = args.unit_name_or_id as string | number;
        const note = args.note as string | undefined;
        
        let foodId: number;
        let unitId: number;
        let foodName: string = ''; // Store names after lookup
        let unitName: string = '';

        // Resolve Food ID
        if (typeof foodRef === 'number') {
          foodId = foodRef;
        } else {
          console.error(`[API] GET /api/food/?query=${encodeURIComponent(foodRef)} - Looking up food ID`);
          try {
            const foodSearch = await apiClient.get(`/api/food/?query=${encodeURIComponent(foodRef)}`);
            if (!foodSearch.data.results || foodSearch.data.results.length === 0) {
              throw new McpError(ErrorCode.InvalidParams, `Food named "${foodRef}" not found.`);
            }
            if (foodSearch.data.results.length > 1) {
              console.warn(`[Warning] Multiple foods found for "${foodRef}". Using first match.`);
            }
            foodId = foodSearch.data.results[0].id;
            foodName = foodSearch.data.results[0].name; // Store the name
            console.error(`[Info] Found Food ID: ${foodId} and Name: "${foodName}" for "${foodRef}"`);
          } catch (err: any) {
            throw new McpError(ErrorCode.InternalError, `Error looking up food "${foodRef}": ${err.message}`);
          }
        }

        // Resolve Unit ID
        if (typeof unitRef === 'number') {
          unitId = unitRef;
        } else {
          console.error(`[API] GET /api/unit/?query=${encodeURIComponent(unitRef)} - Looking up unit ID`);
          try {
            const unitSearch = await apiClient.get(`/api/unit/?query=${encodeURIComponent(unitRef)}`);
             if (!unitSearch.data.results || unitSearch.data.results.length === 0) {
              throw new McpError(ErrorCode.InvalidParams, `Unit named "${unitRef}" not found.`);
            }
             if (unitSearch.data.results.length > 1) {
              console.warn(`[Warning] Multiple units found for "${unitRef}". Using first match.`);
            }
            unitId = unitSearch.data.results[0].id;
            unitName = unitSearch.data.results[0].name; // Store the name
            console.error(`[Info] Found Unit ID: ${unitId} and Name: "${unitName}" for "${unitRef}"`);
          } catch (err: any) {
            throw new McpError(ErrorCode.InternalError, `Error looking up unit "${unitRef}": ${err.message}`);
          }
        }

        // If IDs were provided directly, we need to fetch the names
        if (typeof foodRef === 'number' && !foodName) {
            try {
                const foodDetails = await apiClient.get(`/api/food/${foodId}/`);
                foodName = foodDetails.data.name;
            } catch (err: any) {
                 console.warn(`[Warning] Could not fetch name for food ID ${foodId}: ${err.message}`);
                 // Proceed without name, API might still accept or fail clearly
            }
        }
         if (typeof unitRef === 'number' && !unitName) {
            try {
                const unitDetails = await apiClient.get(`/api/unit/${unitId}/`);
                unitName = unitDetails.data.name;
            } catch (err: any) {
                 console.warn(`[Warning] Could not fetch name for unit ID ${unitId}: ${err.message}`);
                 // Proceed without name
            }
        }


        // Create payload with objects including id and name
        const payload = {
          food: { id: foodId, name: foodName || 'Unknown' }, // Include name
          amount: amount,
          unit: { id: unitId, name: unitName || 'Unknown' }, // Include name
          note: note
        };

        const url = '/api/shopping-list-entry/';
        console.error(`[API] POST ${url} - Payload: ${JSON.stringify(payload)}`);
        try {
          const response = await apiClient.post(url, payload);
          console.error(`[API] POST ${url} - Status: ${response.status}`);
          const newItem = response.data;
          const successMsg = `Successfully added item to shopping list (ID: ${newItem.id}): ${newItem.amount} ${newItem.unit?.name || '?'} ${newItem.food?.name || '?'}.`;
          return { content: [{ type: "text", text: successMsg }] };
        } catch (err: any) {
          console.error(`[Error] Failed to add shopping list item:`, err);
          const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : 'No response data';
          throw new McpError(ErrorCode.InternalError, `Failed to add shopping list item: ${err.message} - API Response: ${errorDetail}`);
        }
      }

      // --- update_shopping_list_item ---
      case "update_shopping_list_item": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null || typeof args.item_id !== 'number') {
          throw new McpError(ErrorCode.InvalidParams, "Missing or invalid required argument: item_id (number).");
        }
        
        const itemId = args.item_id;
        const payload: Record<string, any> = {};
        if (args.amount !== undefined) payload.amount = args.amount as string;
        if (args.unit_id !== undefined) payload.unit = args.unit_id as number;
        if (args.checked !== undefined) payload.checked = args.checked as boolean;
        if (args.note !== undefined) payload.note = args.note as string;

        if (Object.keys(payload).length === 0) {
           throw new McpError(ErrorCode.InvalidParams, "No fields provided to update.");
        }

        const url = `/api/shopping-list-entry/${itemId}/`;
        console.error(`[API] PATCH ${url} - Payload: ${JSON.stringify(payload)}`);
        try {
          const response = await apiClient.patch(url, payload);
          console.error(`[API] PATCH ${url} - Status: ${response.status}`);
          const updatedItem = response.data;
          const successMsg = `Successfully updated shopping list item ID ${itemId}.`;
          return { content: [{ type: "text", text: successMsg }] };
        } catch (err: any) {
          console.error(`[Error] Failed to update shopping list item ${itemId}:`, err);
           const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : 'No response data';
          throw new McpError(ErrorCode.InternalError, `Failed to update shopping list item: ${err.message} - API Response: ${errorDetail}`);
        }
      }

      // --- remove_shopping_list_item ---
      case "remove_shopping_list_item": {
        const args = request.params.arguments;
        if (!args || typeof args !== 'object' || args === null || typeof args.item_id !== 'number') {
          throw new McpError(ErrorCode.InvalidParams, "Missing or invalid required argument: item_id (number).");
        }
        
        const itemId = args.item_id;
        const url = `/api/shopping-list-entry/${itemId}/`;
        console.error(`[API] DELETE ${url}`);
        try {
          const response = await apiClient.delete(url);
          console.error(`[API] DELETE ${url} - Status: ${response.status}`);
          const successMsg = `Successfully removed shopping list item ID ${itemId}.`;
          return { content: [{ type: "text", text: successMsg }] };
        } catch (err: any) {
          console.error(`[Error] Failed to remove shopping list item ${itemId}:`, err);
          const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : 'No response data';
          // Handle 404 Not Found specifically
          if (axios.isAxiosError(err) && err.response?.status === 404) {
             throw new McpError(ErrorCode.InvalidParams, `Shopping list item with ID ${itemId} not found.`);
          }
          throw new McpError(ErrorCode.InternalError, `Failed to remove shopping list item: ${err.message} - API Response: ${errorDetail}`);
        }
      }

      default:
        console.error(`[Error] Unknown tool requested: ${request.params.name}`);
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  } catch (error: any) {
      console.error(`[Error] Tool call failed: ${request.params.name}`, error);
      // Handle Axios errors specifically
      if (axios.isAxiosError(error)) {
          const status = error.response?.status;
          const data = error.response?.data;
          const message = `Tandoor API Error (${status || 'Network Error'}): ${JSON.stringify(data) || error.message}`;
          console.error(`[API Error] ${message}`);
          throw new McpError(ErrorCode.InternalError, message);
      }
      // Handle McpErrors
      if (error instanceof McpError) {
          throw error;
      }
      // Handle generic errors
      throw new McpError(ErrorCode.InternalError, `Tool execution failed: ${error.message}`);
  }
});

// --- Server Start ---
async function main() {
  console.error("[Setup] Initializing Tandoor MCP server...");
  const transport = new StdioServerTransport();
  server.onerror = (error) => console.error('[MCP Error]', error); // Add basic MCP error logging
  process.on('SIGINT', async () => {
      console.error('[Shutdown] Received SIGINT, closing server.');
      await server.close();
      process.exit(0);
  });
  await server.connect(transport);
  console.error("[Setup] Tandoor MCP server running on stdio.");
}

main().catch((error) => {
  console.error("[Fatal] Server failed to start:", error);
  process.exit(1);
});
