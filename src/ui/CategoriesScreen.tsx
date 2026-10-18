import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import {
  Category,
  createCategory,
  deleteCategory,
  Ledger,
  renameCategory,
  TransactionType,
} from '../core/model';
import { Action, Choice, Field, FormError, Screen, Sheet } from './components';
import { colors, ui } from './theme';
import { newId, typeLabels, types } from './TransactionEditor';
import { SaveLedger } from './useLedger';

type Props = {
  ledger: Ledger;
  saving: boolean;
  saveError: string;
  onSave: SaveLedger;
  clearSaveError: () => void;
};

export function CategoriesScreen({
  ledger,
  saving,
  saveError,
  onSave,
  clearSaveError,
  onBack,
}: Props & { onBack: () => void }) {
  const [type, setType] = useState<TransactionType>('expense');
  const [editor, setEditor] = useState<{ category?: Category } | null>(null);
  const categories = ledger.categories.filter((category) => category.type === type);

  return (
    <>
      <Screen>
        <View style={{ marginBottom: 18 }}>
          <Action
            label="Back to wallet"
            secondary
            disabled={saving}
            onPress={onBack}
            testID="categories-back"
          />
        </View>
        <Text style={ui.title} accessibilityRole="header">
          Categories
        </Text>
        <Text style={[ui.body, ui.smallGap]}>
          Group similar transactions. Renaming a category updates its name on existing entries and
          budgets.
        </Text>
        <View style={ui.gap}>
          <Action
            label="+ Add category"
            disabled={saving}
            onPress={() => {
              clearSaveError();
              setEditor({});
            }}
            testID="add-category"
          />
        </View>
        <View style={[ui.row, ui.gap, { flexWrap: 'wrap' }]}>
          {types.map((item) => (
            <Choice
              key={item}
              label={typeLabels[item]}
              selected={type === item}
              onPress={() => setType(item)}
              testID={`category-filter-${item}`}
            />
          ))}
        </View>
        <View style={[styles.list, ui.gap]}>
          {categories.length ? (
            categories.map((category, index) => {
              const uses = ledger.transactions.filter(
                (transaction) => transaction.categoryId === category.id,
              ).length;
              const budgetUses = ledger.budgets.filter(
                (budget) => budget.categoryId === category.id,
              ).length;
              return (
                <Pressable
                  key={category.id}
                  accessibilityRole="button"
                  accessibilityLabel={`Edit category ${category.name}, used by ${uses} transactions and ${budgetUses} budgets`}
                  disabled={saving}
                  testID={`category-${category.id}`}
                  onPress={() => {
                    clearSaveError();
                    setEditor({ category });
                  }}
                  style={({ pressed }) => [
                    styles.row,
                    index > 0 && styles.border,
                    pressed && ui.pressed,
                  ]}
                >
                  <View style={ui.flex}>
                    <Text style={styles.name}>{category.name}</Text>
                    <Text style={[ui.hint, { marginTop: 4 }]}>
                      {uses} {uses === 1 ? 'entry' : 'entries'}
                      {budgetUses > 0
                        ? ` • ${budgetUses} ${budgetUses === 1 ? 'budget' : 'budgets'}`
                        : ''}
                      {category.isDefault ? ' • Included category' : ' • Custom category'}
                    </Text>
                  </View>
                  <Text style={styles.edit}>Edit</Text>
                </Pressable>
              );
            })
          ) : (
            <View style={{ padding: 20 }}>
              <Text style={ui.body}>
                No {typeLabels[type].toLowerCase()} categories. Add one before recording this type
                of transaction.
              </Text>
            </View>
          )}
        </View>
        <Text style={[ui.hint, ui.gap]}>
          A category in use cannot be deleted. Change or remove its linked transactions and budgets
          first.
        </Text>
      </Screen>
      {editor ? (
        <CategoryEditor
          ledger={ledger}
          category={editor.category}
          initialType={type}
          saving={saving}
          saveError={saveError}
          onSave={onSave}
          onClose={() => setEditor(null)}
          clearSaveError={clearSaveError}
        />
      ) : null}
    </>
  );
}

function CategoryEditor({
  ledger,
  category,
  initialType,
  saving,
  saveError,
  onSave,
  onClose,
  clearSaveError,
}: Props & { category?: Category; initialType: TransactionType; onClose: () => void }) {
  const [name, setName] = useState(category?.name ?? '');
  const [type, setType] = useState(category?.type ?? initialType);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const uses = category
    ? ledger.transactions.filter((transaction) => transaction.categoryId === category.id).length
    : 0;
  const budgetUses = category
    ? ledger.budgets.filter((budget) => budget.categoryId === category.id).length
    : 0;

  const save = async () => {
    try {
      const next = category
        ? renameCategory(ledger, category.id, name)
        : createCategory(ledger, { name, type, id: newId('category') });
      if (await onSave(next, `${category ? 'Renamed' : 'Added'} category ${name.trim()}.`))
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Check the category details.');
    }
  };
  const remove = async () => {
    if (!category) return;
    try {
      if (await onSave(deleteCategory(ledger, category.id), `Deleted category ${category.name}.`))
        onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The category could not be deleted.');
    }
  };

  return (
    <Sheet title={category ? 'Edit category' : 'New category'} onClose={onClose} busy={saving}>
      <Field
        label="Category name"
        value={name}
        editable={!saving}
        maxLength={40}
        testID="category-name-input"
        placeholder="e.g. Groceries"
        onChangeText={(value) => {
          setName(value);
          setError('');
          clearSaveError();
        }}
      />
      <Text style={ui.fieldLabel}>Transaction type</Text>
      {category ? (
        <Text style={ui.body}>{typeLabels[category.type]}</Text>
      ) : (
        <View style={[ui.row, { flexWrap: 'wrap' }]}>
          {types.map((item) => (
            <Choice
              key={item}
              label={typeLabels[item]}
              selected={type === item}
              disabled={saving}
              onPress={() => {
                setType(item);
                setError('');
              }}
              testID={`new-category-type-${item}`}
            />
          ))}
        </View>
      )}
      <FormError message={error || saveError} testID="category-error" />
      <View style={ui.gap}>
        <Action
          label={saving ? 'Saving…' : category ? 'Save category' : 'Create category'}
          disabled={saving}
          onPress={() => {
            void save();
          }}
          testID="save-category"
        />
      </View>
      {category ? (
        <View style={ui.gap}>
          <Text style={ui.body}>
            {uses > 0 || budgetUses > 0
              ? `Used by ${uses} ${uses === 1 ? 'entry' : 'entries'} and ${budgetUses} ${budgetUses === 1 ? 'budget' : 'budgets'}. Renaming keeps them linked. To delete, first change or remove these linked records.`
              : 'This category has no entries or budgets and can be deleted.'}
          </Text>
          {!confirmDelete ? (
            <View style={ui.smallGap}>
              <Action
                label="Delete category"
                secondary
                danger
                disabled={saving || uses > 0 || budgetUses > 0}
                onPress={() => setConfirmDelete(true)}
                testID="delete-category"
              />
            </View>
          ) : (
            <>
              <Text style={[ui.body, ui.smallGap]}>
                Delete “{category.name}”? This cannot be undone.
              </Text>
              <View style={ui.smallGap}>
                <Action
                  label="Yes, delete category"
                  secondary
                  danger
                  disabled={saving}
                  onPress={() => {
                    void remove();
                  }}
                  testID="confirm-delete-category"
                />
              </View>
              <View style={ui.smallGap}>
                <Action
                  label="Keep category"
                  secondary
                  disabled={saving}
                  onPress={() => setConfirmDelete(false)}
                />
              </View>
            </>
          )}
        </View>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  list: {
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  row: { padding: 17, minHeight: 78, flexDirection: 'row', alignItems: 'center', gap: 16 },
  border: { borderTopWidth: 1, borderTopColor: colors.border },
  name: { color: colors.text, fontSize: 16, lineHeight: 22, fontWeight: '600' },
  edit: { color: colors.purple, fontSize: 14, fontWeight: '600' },
});
